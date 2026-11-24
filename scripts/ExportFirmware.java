// Local read-only evidence export. No changes to the program database.
// @category Virtual-Braumeister
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.mem.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.io.*;
import java.util.*;

public class ExportFirmware extends GhidraScript {
    String row(Object... v) { List<String> a=new ArrayList<>(); for(Object x:v) a.add("\""+String.valueOf(x).replace("\"","\"\"").replace("\n"," ").replace("\r"," ")+"\""); return String.join(",",a); }
    BufferedWriter writer(Path p,String header) throws Exception { BufferedWriter w=Files.newBufferedWriter(p,StandardCharsets.UTF_8); w.write(header); w.newLine(); return w; }
    void put(BufferedWriter w,Object... v) throws Exception {w.write(row(v)); w.newLine();}
    protected void run() throws Exception {
        Path out=Paths.get(getScriptArgs()[0],currentProgram.getName()); Files.createDirectories(out);
        Listing l=currentProgram.getListing(); FunctionManager fm=currentProgram.getFunctionManager();
        Set<Function> selected=new LinkedHashSet<>();
        String[] known={"782a","7b43","134d4","1350e","7876","78a0","133f9","13420","13390","133c4"};
        for(String k:known) {Function f=fm.getFunctionAt(currentProgram.getAddressFactory().getAddress("code:"+k)); if(f!=null)selected.add(f);}
        try(BufferedWriter w=writer(out.resolve("functions.csv"),"entry,name,body_address_units,signature")) {
            for(Function f:fm.getFunctions(true)) {monitor.checkCancelled(); put(w,f.getEntryPoint(),f.getName(),f.getBody().getNumAddresses(),f.getSignature());}
        }
        Map<String,Integer> histogram=new TreeMap<>();
        try(BufferedWriter a=writer(out.resolve("instructions.csv"),"address,bytes,mnemonic,assembly,function");
            BufferedWriter r=writer(out.resolve("references.csv"),"from,to,type,operand,symbol,function,assembly");
            BufferedWriter c=writer(out.resolve("calls.csv"),"caller,site,target,type");
            BufferedWriter v=writer(out.resolve("vector-candidates.csv"),"address,assembly,flows,warning")) {
            for(Instruction i:l.getInstructions(true)) {
                monitor.checkCancelled(); Function f=fm.getFunctionContaining(i.getAddress()); String owner=f==null?"":f.getEntryPoint().toString();
                StringBuilder b=new StringBuilder(); for(byte x:i.getBytes())b.append(String.format("%02x",x&255));
                put(a,i.getAddress(),b,i.getMnemonicString(),i,owner); histogram.merge(i.getMnemonicString(),1,Integer::sum);
                if(i.getAddress().getAddressSpace().getName().equals("code") && i.getAddress().getOffset()<0x100)
                    put(v,i.getAddress(),i,Arrays.toString(i.getFlows()),"Candidate only: table extent and relocation require validation");
                if(i.getFlowType().isComputed())put(c,owner,i.getAddress(),"UNRESOLVED",i.getFlowType());
                for(Reference ref:i.getReferencesFrom()) {
                    Symbol s=currentProgram.getSymbolTable().getPrimarySymbol(ref.getToAddress());
                    put(r,i.getAddress(),ref.getToAddress(),ref.getReferenceType(),ref.getOperandIndex(),s==null?"":s.getName(),owner,i);
                    if(ref.getReferenceType().isCall())put(c,owner,i.getAddress(),ref.getToAddress(),ref.getReferenceType());
                    if(s!=null && s.getName().matches("(?i)(USART|ADC|TCC|TCD|TCE|TCF|RTC|NVM|OSC|CLK|PMIC|PORT|SPI|TWI|WDT|CPU).*" ) && f!=null)selected.add(f);
                }
            }
        }
        try(BufferedWriter w=writer(out.resolve("opcodes.csv"),"mnemonic,count")){for(String k:histogram.keySet())put(w,k,histogram.get(k));}
        try(BufferedWriter w=writer(out.resolve("metadata.csv"),"kind,name,value,detail")) {
            put(w,"program",currentProgram.getName(),currentProgram.getLanguageID(),currentProgram.getCompilerSpec().getCompilerSpecID());
            for(AddressSpace s:currentProgram.getAddressFactory().getAddressSpaces())put(w,"space",s.getName(),s.getAddressableUnitSize(),s.getSize());
            for(MemoryBlock b:currentProgram.getMemory().getBlocks())put(w,"block",b.getName(),b.getStart(),b.getEnd()+" initialized="+b.isInitialized()+" execute="+b.isExecute());
        }
        DecompInterface d=new DecompInterface();
        try {d.openProgram(currentProgram);
            try(BufferedWriter w=writer(out.resolve("decompiler-status.csv"),"entry,name,completed,error")) {
                for(Function f:selected) {monitor.checkCancelled(); DecompileResults result=d.decompileFunction(f,30,monitor); put(w,f.getEntryPoint(),f.getName(),result.decompileCompleted(),result.getErrorMessage());
                    if(result.decompileCompleted())Files.writeString(out.resolve("decompile-"+f.getEntryPoint().toString().replace(':','_')+".c"),result.getDecompiledFunction().getC());
                }
            }
        } finally {d.dispose();}
        Files.writeString(out.resolve("EXPORT-COMPLETE.txt"),"Read-only export completed. Static references and decompiler output are incomplete evidence, not device specifications.\n");
        println("EXPORT COMPLETE: "+out);
    }
}
