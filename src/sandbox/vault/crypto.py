import os
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

class CryptoManager:
    @staticmethod
    def generate_salt() -> bytes:
        return os.urandom(16)

    @staticmethod
    def generate_nonce() -> bytes:
        return os.urandom(12)

    @staticmethod
    def derive_key(password: str, salt: bytes, iterations: int = 100000) -> bytes:
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=iterations,
        )
        return kdf.derive(password.encode('utf-8'))

    @staticmethod
    def encrypt(plaintext: bytes, key: bytes, nonce: bytes) -> bytes:
        aesgcm = AESGCM(key)
        return aesgcm.encrypt(nonce, plaintext, None)

    @staticmethod
    def decrypt(ciphertext: bytes, key: bytes, nonce: bytes) -> bytes:
        aesgcm = AESGCM(key)
        return aesgcm.decrypt(nonce, ciphertext, None)
