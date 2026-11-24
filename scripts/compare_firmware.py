"""Local static comparison. Firmware-derived outputs must remain private.

No Ghidra database is opened or modified. Python standard library only.
"""
from __future__ import annotations
import argparse
import collections
import csv
import difflib
import hashlib
import json
from pathlib import Path
import re

NAMES = ('BrewControl-1-1-26.hex', 'BrewControl-1-1-27.hex', 'WiFiUpdater.hex')
DEVICE_SOURCE = 'https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-8068-8-and16-bit-AVR-XMEGA-A3-Microcontrollers_Datasheet.pdf'

def read_hex(path):
    memory, base, eof = {}, 0, False
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if eof or not re.fullmatch(r':(?:[0-9A-Fa-f]{2})+', line):
            raise ValueError(f'Invalid HEX syntax/EOF at line {number}')
        b = bytes.fromhex(line[1:])
        if len(b) < 5 or len(b) != b[0] + 5 or sum(b) & 255:
            raise ValueError(f'Invalid HEX length/checksum at line {number}')
        n, a, kind = b[0], int.from_bytes(b[1:3], 'big'), b[3]
        data = b[4:-1]
        if kind == 0:
            for offset, value in enumerate(data, base + a):
                if offset in memory and memory[offset] != value:
                    raise ValueError('Conflicting overlap')
                memory[offset] = value
        elif kind == 1:
            if n or a: raise ValueError('Invalid EOF record')
            eof = True
        elif kind in (2, 4):
            if n != 2 or a: raise ValueError('Invalid extended address')
            base = int.from_bytes(data, 'big') << (4 if kind == 2 else 16)
        elif kind in (3, 5):
            if n != 4 or a: raise ValueError('Invalid start record')
        else: raise ValueError('Unknown HEX record')
    if not eof or not memory: raise ValueError('Missing EOF or empty image')
    return memory

def regions(memory):
    result = []
    for address in sorted(memory):
        if result and result[-1][1] + 1 == address: result[-1][1] = address
        else: result.append([address, address])
    return result

def vector(memory, word):
    b = bytes(memory.get(2 * word + i, 255) for i in range(4))
    op = int.from_bytes(b[:2], 'little')
    if op & 0xfe0e == 0x940c:
        target = ((op & 0x1f0) << 13) | ((op & 1) << 16) | int.from_bytes(b[2:], 'little')
        kind = 'JMP'
    elif op & 0xf000 == 0xc000:
        k = op & 0xfff
        if k & 0x800: k -= 0x1000
        target, kind = word + 1 + k, 'RJMP'
    else: target, kind = None, 'UNKNOWN'
    return dict(slot_word=f'{word:06x}', slot_byte=f'{2*word:06x}', bytes=b.hex(), kind=kind,
                target_word='' if target is None else f'{target:06x}',
                target_byte='' if target is None else f'{2*target:06x}')

def csv_read(path):
    with path.open(encoding='utf-8-sig', newline='') as f: return list(csv.DictReader(f))

def csv_write(path, rows, fields=None):
    rows = list(rows)
    with path.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields or list(rows[0]) if rows else fields or ['empty'])
        writer.writeheader(); writer.writerows(rows)

def addr(value): return int(value.split(':')[-1], 16)
def sha(data): return hashlib.sha256(data).hexdigest()

# Observed-register validation, using A3 section 31 and XMEGA A register summaries.
# Ranges below identify implemented modules. Unlisted offsets remain REVIEW.
MODULES = []
def module(base, size, name, offsets): MODULES.append((base, base+size, name, set(offsets)))
module(0,16,'GPIO',range(16))
for n in range(4): module(0x10+4*n,4,f'VPORT{n}',range(4))
module(0x30,16,'CPU',[4,8,9,10,11,12,13,14,15])
module(0x40,8,'CLK',range(4)); module(0x48,8,'SLEEP',[0])
module(0x50,8,'OSC',range(7))
module(0x60,8,'DFLLRC32M',[0,2,3,4,5,6]); module(0x68,8,'DFLLRC2M',[0,2,3,4,5,6])
module(0x70,8,'PR',range(7)); module(0x78,8,'RST',[0,1]); module(0x80,8,'WDT',[0,1,2])
module(0x90,16,'MCU',[0,1,2,3,4,6,7,8,9]); module(0xa0,16,'PMIC',[0,1,2]); module(0xb0,16,'PORTCFG',[0,2,3,4])
module(0xc0,16,'AES',[0,1,2,3]); module(0x100,0x80,'DMA',range(0x80))
module(0x180,0x40,'EVSYS',list(range(8))+list(range(0x10,0x18))+[0x20,0x21])
module(0x1c0,0x40,'NVM',[0,1,2,4,5,6,10,11,12,13,15,16])
for base,name in [(0x200,'ADCA'),(0x240,'ADCB')]: module(base,0x40,name,list(range(8))+[12,13]+list(range(16,24))+[24,25]+[b+i for b in (0x20,0x28,0x30,0x38) for i in (0,1,2,3,4,5,6)])
module(0x320,0x20,'DACB',[0,1,2,4,5,8,9,10,11,0x18,0x19,0x1a,0x1b])
for base,name in [(0x380,'ACA'),(0x390,'ACB')]: module(base,16,name,range(8))
module(0x400,0x10,'RTC',[0,1,2,3,4,8,9,10,11,12,13])
for base,name in [(0x480,'TWIC'),(0x4a0,'TWIE')]: module(base,0x20,name,range(0x10))
for base,name in [(0x600,'PORTA'),(0x620,'PORTB'),(0x640,'PORTC'),(0x660,'PORTD'),(0x680,'PORTE'),(0x6a0,'PORTF'),(0x7e0,'PORTR')]:
    module(base,0x20,name,list(range(13))+[14]+list(range(16,24)))
for base,name in [(0x800,'TCC0'),(0x840,'TCC1'),(0x900,'TCD0'),(0x940,'TCD1'),(0xa00,'TCE0'),(0xa40,'TCE1'),(0xb00,'TCF0')]:
    offsets=[0,1,2,3,4,6,7,8,9,10,11,12,15,0x20,0x21,0x26,0x27,0x28,0x29,0x2a,0x2b,0x36,0x37,0x38,0x39,0x3a,0x3b]
    if name.endswith('0'):offsets += [0x2c,0x2d,0x2e,0x2f,0x3c,0x3d,0x3e,0x3f]
    module(base,0x40,name,offsets)
for base,name in [(0x880,'AWEXC'),(0xa80,'AWEXE')]: module(base,16,name,range(13))
for base,name in [(0x890,'HIRESC'),(0x990,'HIRESD'),(0xa90,'HIRESE'),(0xb90,'HIRESF')]: module(base,16,name,[0])
for base,name in [(0x8a0,'USARTC0'),(0x8b0,'USARTC1'),(0x9a0,'USARTD0'),(0x9b0,'USARTD1'),(0xaa0,'USARTE0'),(0xab0,'USARTE1'),(0xba0,'USARTF0')]: module(base,16,name,[0,1,3,4,5,6,7])
for base,name in [(0x8c0,'SPIC'),(0x9c0,'SPID'),(0xac0,'SPIE')]: module(base,16,name,[0,1,2,3])
module(0x8f8,8,'IRCOM',[0,1,2])

def device_register(a):
    for start,end,name,offsets in MODULES:
        if start<=a<end:
            return name, 'IMPLEMENTED_REGISTER' if a-start in offsets else 'RESERVED_OR_REVIEW_OFFSET'
    return 'NO_A3_MODULE', 'ABSENT_OR_RESERVED'

class Image:
    def __init__(self, name, firmware, exports):
        self.name=name; self.path=firmware/name; self.memory=read_hex(self.path); self.path_export=exports/name
        self.instructions=csv_read(self.path_export/'instructions.csv'); self.references=csv_read(self.path_export/'references.csv'); self.calls=csv_read(self.path_export/'calls.csv')
        self.functions={x['entry']:x for x in csv_read(self.path_export/'functions.csv')}
        self.ins_by_addr={x['address']:x for x in self.instructions}
        self.body=collections.defaultdict(list);self.refs=collections.defaultdict(list)
        for x in self.references:self.refs[x['from']].append(x)
        for x in self.instructions:
            expected=bytes(self.memory[2*addr(x['address'])+k] for k in range(len(x['bytes'])//2))
            if expected.hex()!=x['bytes']:raise ValueError(f'Instruction mismatch: {name} {x["address"]}')
            if x['function']:self.body[x['function']].append(x)
        self.vectors=[vector(self.memory,a) for a in range(0,0xf4,2)]
        self.start=int(self.vectors[0]['target_word'],16)
        self.eligible={a for a in self.body if addr(a)>=self.start}
        # Recover simple startup immediate loads, not arbitrary execution.
        startbody=self.body[f'code:{self.start:06x}'];registers={};flash=None;data_end=None;bss_end=None
        for x in startbody:
            match=re.fullmatch(r'ldi (\w+),0x([0-9a-f]+)',x['assembly'])
            if match:registers[match[1]]=int(match[2],16)
            if x['assembly']=='out RAMPZ,R16':flash=(registers['R16']<<16)|(registers['Zhi']<<8)|registers['Zlo']
            match=re.fullmatch(r'cpi Xlo,0x([0-9a-f]+)',x['assembly'])
            if match:
                if data_end is None:data_end=(registers['R17']<<8)|int(match[1],16)
                else:bss_end=(registers['R18']<<8)|int(match[1],16)
        self.startup=dict(reset_word=f'{self.start:06x}', data_flash_byte=f'{flash:06x}', data_sram_start='2000',data_sram_end_exclusive=f'{data_end:04x}',bss_end_exclusive=f'{bss_end:04x}')
        self.data_flash=flash
        self.eligible={a for a in self.eligible if addr(a)*2<flash}
    def tokens(self,entry):
        body=self.body[entry];indices={x['address']:n for n,x in enumerate(body)};out=[]
        for x in body:
            asm=x['assembly']
            flow=[r for r in self.refs[x['address']] if r['to'].startswith('code:') and ('JUMP' in r['type'] or 'CALL' in r['type'])]
            if flow:
                target=flow[0]['to'];mark=f'LOCAL_{indices[target]}' if target in indices else 'EXTERNAL_TARGET'
                asm=re.sub(r'0x[0-9a-f]+',mark,asm,count=1)
            out.append(asm)
        return out
    def bytes(self,entry):return b''.join(bytes.fromhex(x['bytes']) for x in self.body[entry])

def match_functions(old,new):
    pairs={}; used=set();methods={}
    def pair(a,b,method):
        if a in old.eligible and b in new.eligible and a not in pairs and b not in used:
            pairs[a]=b;used.add(b);methods[a]=method
    for a,b in zip(old.vectors,new.vectors):
        if a['target_word'] and b['target_word']:pair('code:'+a['target_word'],'code:'+b['target_word'],'same_vector_slot')
    # Main is the first startup call in both images.
    a=next(x['target'] for x in old.calls if x['caller']==f'code:{old.start:06x}')
    b=next(x['target'] for x in new.calls if x['caller']==f'code:{new.start:06x}')
    pair(a,b,'startup_main_call')
    for key,method,min_count in [(lambda im,f:im.bytes(f),'unique_exact_bytes',4),(lambda im,f:tuple(im.tokens(f)),'unique_flow_normalized',8)]:
        ix=[]
        for im,entries in [(old,old.eligible-set(pairs)),(new,new.eligible-used)]:
            d=collections.defaultdict(list)
            for f in sorted(entries):
                if len(im.body[f])>=min_count:d[key(im,f)].append(f)
            ix.append(d)
        for sig,entries in ix[0].items():
            if len(entries)==1 and len(ix[1].get(sig,[]))==1:pair(entries[0],ix[1][sig][0],method)
    # Hardware initialization anchors: match the earliest function writing each
    # specific register, independently of shifted addresses and function names.
    for reg in ('CLK','ADCA_CAL','TCC0_PER','USARTF0_BAUDCTRLA','USARTD0_BAUDCTRLA'):
        anchors=[]
        for im in (old,new):
            candidates=sorted({r['function'] for r in im.references if r['symbol']==reg and r['type']=='WRITE' and r['function'] in im.eligible})
            anchors.append(candidates)
        if all(anchors):pair(anchors[0][0],anchors[1][0],'first_write_'+reg)
    # Conservative mutual-best sequence matches. These are candidates, not identities.
    remaining_old=sorted(old.eligible-set(pairs));remaining_new=sorted(new.eligible-used)
    scores={};tokens_old={a:old.tokens(a) for a in remaining_old};tokens_new={b:new.tokens(b) for b in remaining_new}
    for a,ta in tokens_old.items():
        if len(ta)<8:continue
        for b,tb in tokens_new.items():
            if min(len(ta),len(tb))/max(len(ta),len(tb))<0.7:continue
            sm=difflib.SequenceMatcher(None,ta,tb,autojunk=False)
            if sm.quick_ratio()<0.75:continue
            ratio=sm.ratio()
            if ratio>=0.75:scores[a,b]=ratio
    for a in remaining_old:
        ranked=sorted([(v,b) for (aa,b),v in scores.items() if aa==a],reverse=True)
        if not ranked or (len(ranked)>1 and ranked[0][0]-ranked[1][0]<0.04):continue
        score,b=ranked[0];reverse=sorted([(v,aa) for (aa,bb),v in scores.items() if bb==b],reverse=True)
        if reverse[0][1]==a and (len(reverse)==1 or reverse[0][0]-reverse[1][0]>=0.04):pair(a,b,f'mutual_sequence_candidate_{score:.3f}')
    rows=[];diffs=[]
    for a,b in sorted(pairs.items()):
        ta,tb=old.tokens(a),new.tokens(b)
        exact=old.bytes(a)==new.bytes(b);same=ta==tb
        classification='BYTE_IDENTICAL' if exact else 'FLOW_OPERANDS_ONLY' if same else 'BODY_DIFF_REVIEW'
        rows.append(dict(old_entry=a,new_entry=b,method=methods[a],classification=classification,old_instructions=len(ta),new_instructions=len(tb),similarity=round(difflib.SequenceMatcher(None,ta,tb,autojunk=False).ratio(),4),old_sha256=sha(old.bytes(a)),new_sha256=sha(new.bytes(b))))
        if not exact:
            for tag,i,j,k,l in difflib.SequenceMatcher(None,ta,tb,autojunk=False).get_opcodes():
                if tag!='equal':diffs.append(dict(old_entry=a,new_entry=b,operation=tag,old_evidence=' | '.join(f'{x["address"]}: {x["assembly"]}' for x in old.body[a][i:j]),new_evidence=' | '.join(f'{x["address"]}: {x["assembly"]}' for x in new.body[b][k:l])))
    unmatched=[dict(image=im.name,entry=f,instructions=len(im.body[f]),status='UNMATCHED_NOT_PROOF_OF_ADDITION_OR_REMOVAL') for im,entries in [(old,old.eligible-set(pairs)),(new,new.eligible-used)] for f in sorted(entries)]
    return rows,diffs,unmatched

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--run',type=Path,required=True);parser.add_argument('--firmware',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.output.exists():raise ValueError('Output already exists; use a new private output directory')
    private=Path(__file__).resolve().parents[1]/'private'
    if not args.output.resolve().is_relative_to(private.resolve()):raise ValueError('Output must be inside workspace private directory')
    baseline=json.loads((args.run/'source-before.json').read_text(encoding='utf-8-sig'))
    for entry in baseline:
        if sha(Path(entry['path']).read_bytes()).upper()!=entry['sha256'].upper():raise ValueError(f'Source integrity mismatch: {entry["path"]}')
    images=[Image(n,args.firmware,args.run/'exports') for n in NAMES];args.output.mkdir(parents=True)
    summary=[];validated=[];peripherals=[];strings=[]
    for im in images:
        summary.append(dict(image=im.name,file_sha256=sha(im.path.read_bytes()),loaded_bytes=len(im.memory),regions_byte=regions(im.memory),startup=im.startup,instructions=len(im.instructions),functions=len(im.functions),eligible_function_bodies=len(im.eligible)))
        csv_write(args.output/(im.name+'.vectors.csv'),im.vectors)
        for r in im.references:
            if not r['to'].startswith('mem:') or addr(r['to'])>=0x1000:continue
            module_name,status=device_register(addr(r['to']))
            access=r['type'] in ('READ','WRITE','READ_WRITE')
            body_region=r['function'] in im.eligible
            evidence='DIRECT' if r['assembly'].split(' ')[0] in ('lds','sts','in','out','sbi','cbi','sbic','sbis') else 'RECOVERED_INDIRECT'
            accepted=access and body_region and status=='IMPLEMENTED_REGISTER'
            validated.append(dict(image=im.name,site=r['from'],target=r['to'],symbol=r['symbol'],module=module_name,device_status=status,access_type=r['type'],function=r['function'],assembly=r['assembly'],address_evidence=evidence,application_body_region=body_region,accepted_mmio_candidate=accepted))
        for start,end in regions(im.memory):
            data=bytes(im.memory[x] for x in range(start,end+1))
            for match in re.finditer(rb'[\x20-\x7e]{6,}',data):
                if re.search(rb'(?i)update|firmware|upgrade|wifi|fwversion|AT\+|boot|version',match[0]):strings.append(dict(image=im.name,byte_address=f'{start+match.start():06x}',text=match[0].decode('ascii')))
        for name in sorted({r['module'] for r in validated if r['image']==im.name and r['accepted_mmio_candidate']}):
            group=[r for r in validated if r['image']==im.name and r['module']==name and r['accepted_mmio_candidate']]
            peripherals.append(dict(image=im.name,module=name,references=len(group),direct=sum(x['address_evidence']=='DIRECT' for x in group),indirect=sum(x['address_evidence']=='RECOVERED_INDIRECT' for x in group),registers=';'.join(sorted({x['target'] for x in group})),example_sites=';'.join(x['site'] for x in group[:5])))
    old,new=images[:2];pairs,diffs,unmatched=match_functions(old,new)
    csv_write(args.output/'function-matches.csv',pairs);csv_write(args.output/'function-differences.csv',diffs);csv_write(args.output/'unmatched-functions.csv',unmatched)
    csv_write(args.output/'peripheral-validation.csv',validated);csv_write(args.output/'peripheral-summary.csv',peripherals);csv_write(args.output/'selected-strings.csv',strings)
    comparison=[]
    for a,b in zip(old.vectors,new.vectors):comparison.append(dict(slot_word=a['slot_word'],old_kind=a['kind'],new_kind=b['kind'],old_target=a['target_word'],new_target=b['target_word'],same_bytes=a['bytes']==b['bytes']))
    csv_write(args.output/'brewcontrol-vectors.csv',comparison)
    # Fixed-address byte comparison measures layout changes, not functional change.
    common=set(old.memory)&set(new.memory)
    same=sum(old.memory[a]==new.memory[a] for a in common)
    analysis=[]
    for a,ins in old.ins_by_addr.items():
        other=new.ins_by_addr.get(a)
        if other and ins['bytes']==other['bytes'] and (ins['function']!=other['function'] or ins['assembly']!=other['assembly']):
            analysis.append(dict(address=a,bytes=ins['bytes'],old_function=ins['function'],new_function=other['function'],old_assembly=ins['assembly'],new_assembly=other['assembly'],note='same instruction bytes; changed context/analysis, not independently a firmware change'))
    csv_write(args.output/'same-bytes-different-analysis-context.csv',analysis)
    result=dict(images=summary,comparison=dict(common_bytes=len(common),equal_at_same_address=same,different_at_same_address=len(common)-same,only_old=len(set(old.memory)-set(new.memory)),only_new=len(set(new.memory)-set(old.memory)),function_matches=dict(collections.Counter(x['classification'] for x in pairs)),unmatched=dict(collections.Counter(x['image'] for x in unmatched)),same_bytes_different_analysis_context=len(analysis)),source_integrity='PASS',device_source=DEVICE_SOURCE,script_sha256=sha(Path(__file__).read_bytes()))
    for entry in baseline:
        if sha(Path(entry['path']).read_bytes()).upper()!=entry['sha256'].upper():raise ValueError('Source integrity changed during comparison')
    (args.output/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    (args.output/'COMPARISON-PASS.txt').write_text('All exported instruction bytes revalidated; source hashes unchanged; static comparison complete. Matching candidates require review.\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
