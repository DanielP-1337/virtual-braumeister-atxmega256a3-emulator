/* Independent synthetic TWIE interrupt probe for ATxmega256A3. GNU linker addresses are bytes. */
#include <avr/io.h>
.section .text
.global _start
_start:
    jmp setup

.org 4 * TWIE_TWIM_vect_num
    jmp handler

handler:
    push r0
    in r0, _SFR_IO_ADDR(SREG)
    push r0
    push r16
    in r16, _SFR_IO_ADDR(RAMPZ)
    push r16
    push r31
    call service
    pop r31
    pop r16
    out _SFR_IO_ADDR(RAMPZ), r16
    pop r16
    pop r0
    out _SFR_IO_ADDR(SREG), r0
    pop r0
    reti
service:
    ldi r16, 3
    sts TWIE_MASTER_CTRLC, r16
    ldi r16, 1
    out _SFR_IO_ADDR(RAMPZ), r16
    ldi r31, 0x69
    eor r0, r0
    ret

setup:
    ldi r16, PMIC_LOLVLEN_bm
    sts PMIC_CTRL, r16
    ldi r16, (1 << 6) | TWI_MASTER_WIEN_bm | TWI_MASTER_ENABLE_bm
    sts TWIE_MASTER_CTRLA, r16
    ldi r16, 1                      /* MASTER.STATUS BUSSTATE = IDLE */
    sts TWIE_MASTER_STATUS, r16
    ldi r16, 0xae
    sts TWIE_MASTER_ADDR, r16
wait_flag:
    lds r16, TWIE_MASTER_STATUS
    sbrs r16, 6
    rjmp wait_flag
    ldi r16, 3
    out _SFR_IO_ADDR(RAMPZ), r16
    ldi r16, 0x47
    mov r0, r16
    ldi r31, 0x39
    ldi r16, 0x55
    out _SFR_IO_ADDR(SREG), r16
    ldi r16, 0xac
    jmp enable_irq

.section .upper,"ax",@progbits
.global enable_irq, resume, finished
enable_irq:
    sei
    nop
resume:
    sts 0x2000, r0
    sts 0x2001, r16
    sts 0x2002, r31
    in r17, _SFR_IO_ADDR(SREG)
    sts 0x2003, r17
    in r17, _SFR_IO_ADDR(RAMPZ)
    sts 0x2004, r17
    lds r17, PMIC_STATUS
    sts 0x2005, r17
finished:
    rjmp finished
