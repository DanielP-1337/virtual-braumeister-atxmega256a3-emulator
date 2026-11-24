"""Synthetic tests only; no proprietary firmware fixtures."""
import tempfile
import unittest
from pathlib import Path
from compare_firmware import read_hex, vector, device_register

def record(address, kind, data):
    b=bytes([len(data),address>>8,address&255,kind])+bytes(data)
    return ':'+(b+bytes([-sum(b)&255])).hex()

class ComparisonTests(unittest.TestCase):
    def test_extended_segment_and_linear_addresses(self):
        private=Path(__file__).resolve().parents[1]/'private'/'comparison-tests'
        private.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=private) as temp:
            p=Path(temp)/'synthetic.hex'
            p.write_text('\n'.join([record(0,2,[0x10,0]),record(2,0,[0x42]),record(0,4,[0,2]),record(3,0,[0x24]),record(0,1,[])]))
            self.assertEqual(read_hex(p),{0x10002:0x42,0x20003:0x24})
            p.write_text(':0100000042BE\n:00000001FF\n')
            with self.assertRaisesRegex(ValueError,'checksum'):read_hex(p)

    def test_jmp_vector_word_target(self):
        # JMP encoding: target word 0x12345; byte target 0x2468a.
        m=dict(enumerate(bytes.fromhex('0d944523')))
        self.assertEqual(vector(m,0)['target_word'],'012345')
        self.assertEqual(vector(m,0)['target_byte'],'02468a')

    def test_rjmp_forward_and_backward(self):
        # PC 0xee + 1 + 0x787 = 0x876; padding is not another vector.
        m={0x1dc:0x87,0x1dd:0xc7,0x1de:0,0x1df:0}
        self.assertEqual(vector(m,0xee)['target_word'],'000876')
        m={0x200:0xff,0x201:0xcf,0x202:0,0x203:0}
        self.assertEqual(vector(m,0x100)['target_word'],'000100')

    def test_device_instance_and_reserved_usart_offset(self):
        self.assertEqual(device_register(0xba4),('USARTF0','IMPLEMENTED_REGISTER'))
        self.assertEqual(device_register(0xba2),('USARTF0','RESERVED_OR_REVIEW_OFFSET'))
        self.assertEqual(device_register(0xbc2),('NO_A3_MODULE','ABSENT_OR_RESERVED'))
        self.assertEqual(device_register(0xbb0),('NO_A3_MODULE','ABSENT_OR_RESERVED'))

if __name__=='__main__':unittest.main()
