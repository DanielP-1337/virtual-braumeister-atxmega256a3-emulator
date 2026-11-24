/* Synthetic ATxmega256A3 program. Reset enters _start at flash byte zero. */
.section .text
.global _start
_start:

/* Each case seeds every SREG bit, loads the source register, and samples
 * CPU.SREG on either side of the OUT under test. IN and STS preserve SREG.
 * Each three-byte SRAM record contains the input SREG, R16, and output SREG.
 */
.macro probe number, seed, value
  ldi r16, \seed
  out 0x3f, r16
  ldi r16, \value
  in r17, 0x3f
.global out_case\number
out_case\number:
  out 0x3f, r16
.global in_after\number
in_after\number:
  in r18, 0x3f
  sts (0x2000 + 3 * (\number - 1)), r17
  sts (0x2001 + 3 * (\number - 1)), r16
  sts (0x2002 + 3 * (\number - 1)), r18
.endm

probe 1, 0xa1, 0x0b
probe 2, 0x53, 0xac
probe 3, 0xb6, 0xc9
probe 4, 0x65, 0x1a

.global finished
finished:
  rjmp finished
