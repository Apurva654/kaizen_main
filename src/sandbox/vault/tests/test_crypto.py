import unittest
import os
import tempfile
from src.sandbox.vault.crypto import CryptoManager
from src.sandbox.vault.storage import VaultManager

class TestVaultCrypto(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.TemporaryDirectory()
        self.password = "SuperSecretPassword123!"
        self.plaintext = b"Confidential payload data for vault testing."
        
        self.input_file = os.path.join(self.test_dir.name, "plain.txt")
        self.vault_file = os.path.join(self.test_dir.name, "vault.enc")
        self.output_file = os.path.join(self.test_dir.name, "decrypted.txt")
        
        with open(self.input_file, "wb") as f:
            f.write(self.plaintext)

    def tearDown(self):
        self.test_dir.cleanup()

    def test_roundtrip_encryption(self):
        VaultManager.encrypt_file(self.input_file, self.vault_file, self.password)
        self.assertTrue(os.path.exists(self.vault_file))
        
        VaultManager.decrypt_file(self.vault_file, self.output_file, self.password)
        with open(self.output_file, "rb") as f:
            decrypted_data = f.read()
            
        self.assertEqual(self.plaintext, decrypted_data)

    def test_wrong_password_failure(self):
        VaultManager.encrypt_file(self.input_file, self.vault_file, self.password)
        with self.assertRaises(ValueError):
            VaultManager.decrypt_file(self.vault_file, self.output_file, "WrongPassword")

    def test_tampered_ciphertext_integrity_failure(self):
        VaultManager.encrypt_file(self.input_file, self.vault_file, self.password)
        
        with open(self.vault_file, "rb") as f:
            payload = bytearray(f.read())
            
        # Tamper with a byte in the ciphertext portion
        payload[-1] ^= 0xFF
        
        with open(self.vault_file, "wb") as f:
            f.write(payload)
            
        with self.assertRaises(ValueError):
            VaultManager.decrypt_file(self.vault_file, self.output_file, self.password)

    def test_inspect_vault(self):
        VaultManager.encrypt_file(self.input_file, self.vault_file, self.password)
        info = VaultManager.inspect_vault(self.vault_file)
        
        self.assertIn("salt_hex", info)
        self.assertIn("nonce_hex", info)
        self.assertEqual(info["ciphertext_length"], len(self.plaintext) + 16) # AESGCM tag overhead

if __name__ == "__main__":
    unittest.main()
