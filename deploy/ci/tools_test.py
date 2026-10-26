# SPDX-License-Identifier: LicenseRef-Proprietary
import hashlib
import unittest
from tools import verified


class Checksums(unittest.TestCase):
    def test_accepts_locked_bytes(self):
        self.assertEqual(verified(b'fixture', hashlib.sha256(b'fixture').hexdigest()), b'fixture')

    def test_refuses_changed_binary(self):
        with self.assertRaisesRegex(ValueError, 'PLAT_TOOL_CHECKSUM'):
            verified(b'changed', hashlib.sha256(b'fixture').hexdigest())


if __name__ == '__main__':
    unittest.main()
