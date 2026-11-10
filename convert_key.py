import base64, struct, sys, os

src = r'C:\Users\Administrator\Desktop\devoops\openclaw-wangshu.pem'
out = os.path.join(os.environ['TEMP'], 'goalos_rsa.pem')

raw = open(src, 'r', encoding='ascii').read()
body = ''.join(l for l in raw.splitlines() if '-----' not in l)
data = base64.b64decode(body)

def read_str(buf, pos):
    n = struct.unpack('>I', buf[pos:pos+4])[0]
    return buf[pos+4:pos+4+n], pos+4+n

pos = 0
magic = data[:15]
assert magic == b'openssh-key-v1\x00', magic
pos = 15
cipher, pos = read_str(data, pos)
kdf, pos = read_str(data, pos)
kdfopt, pos = read_str(data, pos)
nkeys = struct.unpack('>I', data[pos:pos+4])[0]; pos += 4
print('cipher:', cipher, '| kdf:', kdf, '| nkeys:', nkeys)

pub, pos = read_str(data, pos)
priv_blob, pos = read_str(data, pos)

ptype, p = read_str(priv_blob, 0)
print('key type:', ptype)

def read_mpint(buf, pos):
    n = struct.unpack('>I', buf[pos:pos+4])[0]
    return int.from_bytes(buf[pos+4:pos+4+n], 'big'), pos+4+n

ck1, ck2 = struct.unpack('>II', priv_blob[p:p+8]); p += 8
print('checkints match:', ck1 == ck2)

t, p = read_str(priv_blob, p)
n_, p = read_mpint(priv_blob, p)
e_, p = read_mpint(priv_blob, p)
d_, p = read_mpint(priv_blob, p)
iqmp, p = read_mpint(priv_blob, p)
p_, p = read_mpint(priv_blob, p)
q_, p = read_mpint(priv_blob, p)

print('bits:', n_.bit_length(), '| e:', e_)

def der_int(i):
    b = i.to_bytes((i.bit_length() + 7) // 8 or 1, 'big')
    if b[0] & 0x80:
        b = b'\x00' + b
    return b'\x02' + der_len(len(b)) + b

def der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(b)]) + b

def der_seq(*items):
    body = b''.join(items)
    return b'\x30' + der_len(len(body)) + body

rsa_priv = der_seq(
    der_int(0), der_int(n_), der_int(e_), der_int(d_),
    der_int(p_), der_int(q_), der_int(d_ % (p_ - 1)), der_int(d_ % (q_ - 1)), der_int(iqmp)
)
pem = ('-----BEGIN RSA PRIVATE KEY-----\n'
       + '\n'.join(base64.b64encode(rsa_priv).decode()[i:i+64] for i in range(0, len(base64.b64encode(rsa_priv).decode()), 64))
       + '\n-----END RSA PRIVATE KEY-----\n')
open(out, 'w', newline='\n').write(pem)
print('written:', out, len(pem), 'bytes')
