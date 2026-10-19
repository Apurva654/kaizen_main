import struct
from src.sandbox.vault.crypto import CryptoManager

class VaultManager:
    @staticmethod
    def pack_vault(salt: bytes, nonce: bytes, ciphertext: bytes) -> bytes:
        # Format:
        # [1 byte] salt length (16)
        # [16 bytes] salt
        # [1 byte] nonce length (12)
        # [12 bytes] nonce
        # [4 bytes big-endian] ciphertext length
        # [N bytes] ciphertext
        if len(salt) != 16:
            raise ValueError("Salt must be exactly 16 bytes")
        if len(nonce) != 12:
            raise ValueError("Nonce must be exactly 12 bytes")
        
        header = struct.pack(">B 16s B 12s I", len(salt), salt, len(nonce), nonce, len(ciphertext))
        return header + ciphertext

    @staticmethod
    def unpack_vault(payload: bytes):
        if len(payload) < 34:
            raise ValueError("Invalid payload: too short")
        
        salt_len = payload[0]
        if salt_len != 16:
            raise ValueError("Invalid salt length in payload")
        salt = payload[1:17]
        
        nonce_len = payload[17]
        if nonce_len != 12:
            raise ValueError("Invalid nonce length in payload")
        nonce = payload[18:30]
        
        ciphertext_len = struct.unpack(">I", payload[30:34])[0]
        ciphertext = payload[34:34 + ciphertext_len]
        
        if len(ciphertext) != ciphertext_len:
            raise ValueError("Payload corrupted: ciphertext length mismatch")
            
        return salt, nonce, ciphertext

    @classmethod
    def encrypt_file(cls, input_path: str, output_path: str, password: str):
        with open(input_path, "rb") as f:
            plaintext = f.read()
            
        salt = CryptoManager.generate_salt()
        nonce = CryptoManager.generate_nonce()
        key = CryptoManager.derive_key(password, salt)
        ciphertext = CryptoManager.encrypt(plaintext, key, nonce)
        
        packed = cls.pack_vault(salt, nonce, ciphertext)
        with open(output_path, "wb") as f:
            f.write(packed)

    @classmethod
    def decrypt_file(cls, input_path: str, output_path: str, password: str):
        with open(input_path, "rb") as f:
            payload = f.read()
            
        salt, nonce, ciphertext = cls.unpack_vault(payload)
        key = CryptoManager.derive_key(password, salt)
        
        try:
            plaintext = CryptoManager.decrypt(ciphertext, key, nonce)
        except Exception as e:
            raise ValueError("Decryption failed: Incorrect password or tampered data") from e
            
        with open(output_path, "wb") as f:
            f.write(plaintext)

    @classmethod
    def inspect_vault(cls, input_path: str) -> dict:
        with open(input_path, "rb") as f:
            payload = f.read()
            
        salt, nonce, ciphertext = cls.unpack_vault(payload)
        return {
            "salt_hex": salt.hex(),
            "nonce_hex": nonce.hex(),
            "ciphertext_length": len(ciphertext),
            "total_payload_length": len(payload)
        }
