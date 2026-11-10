"""ssh_run.py — 用 paramiko 连服务器跑命令/传文件（本机 ssh 7.7 读不了这把 OpenSSH v1 密钥）。

用法:
  python ssh_run.py exec "uname -a"
  python ssh_run.py put 本地路径 远端路径
  python ssh_run.py putdir 本地目录 远端目录
"""
import sys, os, stat
import paramiko
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HOST = os.environ.get('GOALOS_HOST', 'YOUR_SERVER_IP')
USER = os.environ.get('GOALOS_USER', 'root')
KEY = os.path.join(os.environ.get('USERPROFILE', ''), 'Desktop', 'devoops', 'openclaw-wangshu.pem')


def client():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        pkey = paramiko.RSAKey.from_private_key_file(KEY)
    except Exception:
        from cryptography.hazmat.primitives import serialization
        with open(KEY, 'rb') as f:
            pkey = serialization.load_ssh_private_key(f.read(), password=None)
        pkey = paramiko.RSAKey(data=pkey.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption()))
    c.connect(HOST, username=USER, pkey=pkey, timeout=20, banner_timeout=25, auth_timeout=25)
    return c


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'exec'
    c = client()
    try:
        if mode == 'exec':
            cmd = sys.argv[2]
            stdin, stdout, stderr = c.exec_command(cmd, timeout=300)
            out = stdout.read().decode('utf-8', 'replace')
            err = stderr.read().decode('utf-8', 'replace')
            code = stdout.channel.recv_exit_status()
            if out.strip():
                print(out.rstrip())
            if err.strip():
                print('[stderr]', err.rstrip())
            print('[exit]', code)
        elif mode == 'put':
            sftp = c.open_sftp()
            sftp.put(sys.argv[2], sys.argv[3])
            sftp.close()
            print('uploaded', sys.argv[2], '->', sys.argv[3])
        elif mode == 'putdir':
            local, remote = sys.argv[2], sys.argv[3]
            sftp = c.open_sftp()

            def ensure(d):
                try:
                    sftp.stat(d)
                except IOError:
                    sftp.mkdir(d)

            ensure(remote)
            for root, dirs, files in os.walk(local):
                rel = os.path.relpath(root, local).replace('\\', '/')
                rd = remote if rel == '.' else f'{remote}/{rel}'
                if rel != '.':
                    ensure(rd)
                for fn in files:
                    sftp.put(os.path.join(root, fn), f'{rd}/{fn}')
            sftp.close()
            print('uploaded dir', local, '->', remote)
    finally:
        c.close()


if __name__ == '__main__':
    main()
