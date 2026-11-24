/* Independent ADIW fixture. Each snapshot preserves all registers and SREG. */
.section .text
.global _start
_start:
.irp n,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
  ldi r16, (0x90 + \n)
  mov r\n, r16
.endr
.irp n,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31
  ldi r\n, (0x90 + \n)
.endr

/* STS, LDS and IN leave flags alone. Save R16 before borrowing it for SREG. */
.macro snapshot base
  .irp j,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31
    sts (\base + \j), r\j
  .endr
  in r16, 0x3f
  sts (\base + 32), r16
  lds r16, (\base + 16)
.endm

.macro measure n, lo, hi, entry, k, flags
  ldi \lo, lo8(\entry)
  ldi \hi, hi8(\entry)
  ldi r16, \flags
  out 0x3f, r16
  snapshot (0x2000+66*(\n-1))
.global case\n
case\n:
  adiw \lo, \k
.global case\n\()_after
case\n\()_after:
  snapshot (0x2000+66*(\n-1)+33)
.endm

measure 1, r24, r25, 0x0000, 0,  0xff
measure 2, r26, r27, 0x00ff, 1,  0x7f
measure 3, r28, r29, 0x7fff, 1,  0xf3
measure 4, r30, r31, 0xffff, 1,  0x3c
measure 5, r24, r25, 0x7fc1, 63, 0xdf
measure 6, r26, r27, 0xffff, 32, 0xaf
measure 7, r28, r29, 0x8000, 0,  0x0b
measure 8, r30, r31, 0xfffe, 16, 0x5f
.global finished
finished:
  rjmp finished
