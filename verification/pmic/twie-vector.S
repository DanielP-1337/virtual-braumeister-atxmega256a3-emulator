/* Independent, synthetic ATxmega256A3 probe. GNU AVR linker addresses are bytes.
 * The .upper section is linked at flash byte 0x24686, word 0x12343.
 * The test peer explicitly acknowledges both address phases and supplies 0x39.
 */
#include <avr/io.h>

.section .text
.global _start
_start:
    jmp setup

.org 4 * TWIE_TWIM_vect_num
    jmp twie_isr

twie_isr:
    lds r17, TWIE_MASTER_STATUS
    sbrc r17, 7
    rjmp receive
    sts 0x2000, r17
    lds r17, PMIC_STATUS
    sts 0x2001, r17
    in r17, 0x3f
    sts 0x2002, r17
    ldi r18, 3
    sts TWIE_MASTER_CTRLC, r18
    reti
receive:
    sts 0x2005, r17
    lds r17, TWIE_MASTER_DATA
    sts 0x2006, r17
    ldi r18, 7
    sts TWIE_MASTER_CTRLC, r18
    reti

setup:
    ldi r16, PMIC_LOLVLEN_bm
    sts PMIC_CTRL, r16
    ldi r16, 0x78
    sts TWIE_MASTER_CTRLA, r16
    ldi r16, 1
    sts TWIE_MASTER_STATUS, r16
    ldi r16, 0xae
    sts TWIE_MASTER_ADDR, r16
wait_write:
    lds r17, TWIE_MASTER_STATUS
    sbrs r17, 6
    rjmp wait_write
    ldi r16, 0x35
    out 0x3f, r16
    jmp enable_irq

.section .upper,"ax",@progbits
.global enable_irq, resume_write, finished
enable_irq:
    sei
    ldi r20, 0x5a
resume_write:
    sts 0x2003, r20
    ldi r16, 0xaf
    sts TWIE_MASTER_ADDR, r16
wait_read:
    lds r21, 0x2006
    cpi r21, 0x39
    brne wait_read
    lds r21, PMIC_STATUS
    sts 0x2007, r21
finished:
    rjmp finished
