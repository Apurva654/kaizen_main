import unittest
import sys
import os
sys.path.insert(0, os.getcwd())
from src.sandbox.episodic_demo import divide

class TestEpisodicDemo(unittest.TestCase):
    def test_divide_valid(self):
        self.assertEqual(divide(10, 2), 5)
    def test_divide_zero(self):
        with self.assertRaises(ValueError):
            divide(10, 0)

if __name__ == '__main__':
    unittest.main()
