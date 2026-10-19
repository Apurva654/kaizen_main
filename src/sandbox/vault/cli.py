import argparse
import sys
from src.sandbox.vault.storage import VaultManager

def main():
    parser = argparse.ArgumentParser(description="Secure File Vault CLI Tool")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Encrypt command
    enc_parser = subparsers.add_parser("encrypt", help="Encrypt a file")
    enc_parser.add_argument("-i", "--input", required=True, help="Path to input plaintext file")
    enc_parser.add_argument("-o", "--output", required=True, help="Path to output vault file")
    enc_parser.add_argument("-p", "--password", required=True, help="Vault password")

    # Decrypt command
    dec_parser = subparsers.add_parser("decrypt", help="Decrypt a vault file")
    dec_parser.add_argument("-i", "--input", required=True, help="Path to input vault file")
    dec_parser.add_argument("-o", "--output", required=True, help="Path to output plaintext file")
    dec_parser.add_argument("-p", "--password", required=True, help="Vault password")

    # Inspect command
    insp_parser = subparsers.add_parser("inspect", help="Inspect vault file metadata")
    insp_parser.add_argument("-i", "--input", required=True, help="Path to input vault file")

    args = parser.parse_args()

    try:
        if args.command == "encrypt":
            VaultManager.encrypt_file(args.input, args.output, args.password)
            print(f"Successfully encrypted {args.input} -> {args.output}")
        elif args.command == "decrypt":
            VaultManager.decrypt_file(args.input, args.output, args.password)
            print(f"Successfully decrypted {args.input} -> {args.output}")
        elif args.command == "inspect":
            info = VaultManager.inspect_vault(args.input)
            print("Vault Metadata:")
            for k, v in info.items():
                print(f"  {k}: {v}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
