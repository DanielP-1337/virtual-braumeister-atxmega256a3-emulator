// Export XMEGA peripheral-register references from the current Ghidra program.
// Read-only analysis: does not modify the imported firmware or Ghidra database.
// @category Virtual-Braumeister
// @author Virtual-Braumeister project

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolTable;

import java.io.BufferedWriter;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public class Export_XmegaRegisterReferences extends GhidraScript {

    // Include named XMEGA hardware registers. The built-in Ghidra XMEGA
    // language definition must supply register labels for a match.
    private static final String[] PERIPHERAL_PREFIXES = {
        "PORT", "VPORT", "USART", "UART", "ADC", "DAC", "AC", "TCC", "TCD",
        "TCE", "TCF", "TC0", "TC1", "RTC", "NVM", "OSC", "CLK", "PMIC",
        "DMA", "SPI", "TWI", "AES", "WDT", "EVSYS", "HIRES", "AWEX",
        "EBI", "USB", "RST", "SLEEP", "DFLL", "PR_", "CPU_", "GPIOR"
    };

    private static String category(String symbol) {
        String n = symbol.toUpperCase(Locale.ROOT);
        if (n.startsWith("PORT") || n.startsWith("VPORT")) return "GPIO";
        if (n.startsWith("USART") || n.startsWith("UART")) return "USART";
        if (n.startsWith("ADC")) return "ADC";
        if (n.startsWith("DAC")) return "DAC";
        if (n.startsWith("TCC") || n.startsWith("TCD") || n.startsWith("TCE") ||
            n.startsWith("TCF") || n.startsWith("TC0") || n.startsWith("TC1") ||
            n.startsWith("RTC") || n.startsWith("AWEX") || n.startsWith("HIRES")) return "TIMER";
        if (n.startsWith("NVM")) return "NVM";
        if (n.startsWith("OSC") || n.startsWith("CLK") || n.startsWith("DFLL")) return "CLOCK";
        if (n.startsWith("PMIC")) return "INTERRUPT";
        if (n.startsWith("DMA")) return "DMA";
        if (n.startsWith("SPI")) return "SPI";
        if (n.startsWith("TWI")) return "TWI";
        if (n.startsWith("AC")) return "ANALOG_COMPARATOR";
        if (n.startsWith("EBI")) return "EXTERNAL_BUS";
        if (n.startsWith("WDT") || n.startsWith("RST") || n.startsWith("SLEEP")) return "SYSTEM";
        return "OTHER_PERIPHERAL";
    }

    private static boolean isPeripheralSymbol(String name) {
        String n = name.toUpperCase(Locale.ROOT);
        // Exclude ordinary automatic labels and compiler-generated RAM names.
        if (n.startsWith("DAT_") || n.startsWith("LAB_") || n.startsWith("FUN_") ||
            n.startsWith("UNK_") || n.startsWith("SUB_")) return false;
        for (String p : PERIPHERAL_PREFIXES) {
            if (n.startsWith(p)) return true;
        }
        return false;
    }

    private static String access(RefType type) {
        if (type == null) return "UNKNOWN";
        boolean read = type.isRead();
        boolean write = type.isWrite();
        if (read && write) return "READ_WRITE";
        if (write) return "WRITE";
        if (read) return "READ";
        return "UNKNOWN"; // Do not infer a direction from an STS/LDS string alone.
    }

    private static String csv(String value) {
        if (value == null) value = "";
        return "\"" + value.replace("\"", "\"\"").replace("\r", " ").replace("\n", " ") + "\"";
    }

    private static String row(String... values) {
        List<String> fields = new ArrayList<>();
        for (String value : values) fields.add(csv(value));
        return String.join(",", fields);
    }

    private String bestRegisterName(SymbolTable table, Address address) {
        Symbol primary = table.getPrimarySymbol(address);
        if (primary != null && isPeripheralSymbol(primary.getName())) return primary.getName();
        for (Symbol candidate : table.getSymbols(address)) {
            if (isPeripheralSymbol(candidate.getName())) return candidate.getName();
        }
        return null;
    }

    @Override
    protected void run() throws Exception {
        if (currentProgram == null) {
            printerr("Open an imported BrewControl firmware in CodeBrowser first.");
            return;
        }
        String languageId = currentProgram.getLanguageID().toString();
        if (!languageId.toLowerCase(Locale.ROOT).contains("xmega")) {
            println("WARNING: Selected language is " + languageId + ", not an XMEGA profile.");
        }

        File directory = new File(getScriptArgs()[0]);
        if (!directory.isDirectory()) throw new IllegalArgumentException("Invalid output folder");
        String base = currentProgram.getName().replaceAll("[^A-Za-z0-9._-]", "_");
        String stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
        Path output = new File(directory, base + "-xmega-register-references-" + stamp + ".csv").toPath();

        SymbolTable symbols = currentProgram.getSymbolTable();
        InstructionIterator instructions = currentProgram.getListing().getInstructions(true);
        int count = 0;
        int seenInstructions = 0;
        int instructionsWithRefs = 0;
        int unknownDirection = 0;
        List<String> categories = new ArrayList<>();

        // A single row per Ghidra reference. Multiple references from one instruction
        // (and multiple operand indices) are intentionally preserved.
        try (BufferedWriter writer = Files.newBufferedWriter(output, StandardCharsets.UTF_8)) {
            writer.write(row("firmware", "language", "function_address", "function_name",
                "instruction_address", "mnemonic", "instruction", "operand_index",
                "register_address", "register_name", "category", "access", "reference_type",
                "reference_source"));
            writer.newLine();

            while (instructions.hasNext()) {
                monitor.checkCancelled();
                Instruction instruction = instructions.next();
                seenInstructions++;
                Reference[] references = instruction.getReferencesFrom();
                if (references.length > 0) instructionsWithRefs++;
                Function function = currentProgram.getFunctionManager()
                    .getFunctionContaining(instruction.getAddress());
                String functionName = function == null ? "" : function.getName();
                String functionAddress = function == null ? "" : function.getEntryPoint().toString();

                for (Reference reference : references) {
                    Address target = reference.getToAddress();
                    if (target == null || !target.isMemoryAddress()) continue;
                    String register = bestRegisterName(symbols, target);
                    if (register == null) continue;
                    String kind = access(reference.getReferenceType());
                    if (kind.equals("UNKNOWN")) unknownDirection++;
                    String group = category(register);
                    if (!categories.contains(group)) categories.add(group);
                    writer.write(row(currentProgram.getName(), languageId,
                        functionAddress, functionName, instruction.getAddress().toString(),
                        instruction.getMnemonicString(), instruction.toString(),
                        Integer.toString(reference.getOperandIndex()), target.toString(),
                        register, group, kind, reference.getReferenceType().toString(),
                        reference.getSource().toString()));
                    writer.newLine();
                    count++;
                }
            }
        }
        Collections.sort(categories);
        println("=== XMEGA REGISTER REFERENCE EXPORT ===");
        println("Firmware: " + currentProgram.getName());
        println("Language: " + languageId);
        println("Decoded instructions scanned: " + seenInstructions);
        println("Instructions with any references: " + instructionsWithRefs);
        println("Named peripheral references exported: " + count);
        println("References with unknown read/write direction: " + unknownDirection);
        println("Categories: " + String.join(", ", categories));
        println("CSV: " + output.toAbsolutePath());
        println("NOTE: Only Ghidra-created references to named register symbols are exported.");
        println("Computed/indirect accesses and unnamed or unreferenced registers are NOT detected.");
        println("Validate important matches against instruction operands and the device datasheet.");
    }
}

