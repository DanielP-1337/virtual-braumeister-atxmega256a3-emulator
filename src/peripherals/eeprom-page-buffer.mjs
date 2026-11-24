import { EEPROM_PAGE_SIZE, EEPROM_SIZE, EEPROMStorage } from '../eeprom-storage.mjs';

// Slots are positions within a page. The programming address selects the
// destination page independently of the addresses used to load the buffer.
export class EEPROMPageBuffer {
  #data = new Uint8Array(EEPROM_PAGE_SIZE);
  #tags = new Uint8Array(EEPROM_PAGE_SIZE);
  #storage;

  constructor(storage) {
    if (!(storage instanceof EEPROMStorage)) throw new TypeError('Expected EEPROM storage');
    this.#storage = storage;
    this.clear();
  }

  get storage() { return this.#storage; }
  get loaded() { return this.#tags.includes(1); }

  clear() {
    this.#data.fill(0xff);
    this.#tags.fill(0);
  }

  load(offset, value) {
    checkOffset(offset);
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Invalid EEPROM byte');
    const slot = offset % EEPROM_PAGE_SIZE;
    this.#data[slot] &= value;
    this.#tags[slot] = 1;
  }

  // Effect of an already completed atomic erase/write. Authorization and the
  // programming deadline belong to the NVM controller.
  completeEraseWrite(offset) {
    checkOffset(offset);
    const base = offset - (offset % EEPROM_PAGE_SIZE);
    for (let slot = 0; slot < EEPROM_PAGE_SIZE; slot++) {
      if (this.#tags[slot]) this.#storage.programByte(base + slot, this.#data[slot]);
    }
    this.clear();
  }
}

function checkOffset(offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= EEPROM_SIZE) {
    throw new RangeError('Offset outside device EEPROM');
  }
}
