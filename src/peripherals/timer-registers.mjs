// Shared 8-bit CPU access to XMEGA timer registers. Each timer owns its TEMP and active PER.
export const TEMP_OFFSET = 0x0f;
export const PERIOD_OFFSET = 0x26;

export function resetTimerRegisters(timer) {
  timer.temp = 0;
  timer.per = 0xffff;
}

export function timerRegisterMappers(timer, registry, addresses, { context = () => ({}), beforeAccess,
  fault = (reason, details) => { throw Object.assign(new Error(reason), details); } } = {}) {
  if (timer.registered || addresses.some(address => registry.handlers.has(address))) {
    throw new Error(timer.peripheral + ' counter MMIO registration collision');
  }

  const mapByte = (addressByte, register, read, write, report, state, validateWrite) => {
    const access = (kind, value, cycle) => {
      const issue = kind === 'write' && validateWrite?.(value);
      if (!issue) beforeAccess?.(addressByte, kind, cycle);
      const before = report ? state() : null;
      if (kind === 'read') value = read();
      else if (!issue) write(value);
      const classification = issue && timer.peripheral + '_' + issue.code;
      report?.({ origin: 'peripheral-model', eventType: 'timer-access', ...context(), peripheral: timer.peripheral,
        register, addressByte, kind, cycle, value, completed: !issue, ...(issue ? { classification } : {}), before, after: state() });
      if (issue) return fault(issue.reason, { classification, addressByte, accessKind: kind, attemptedValue: value });
      return value;
    };
    registry.map(addressByte, {
      read: cycle => access('read', undefined, cycle),
      write: (value, cycle) => access('write', value, cycle),
    });
  };

  const mapWord = (lowAddress, name, readWord, writeWord, report, state) => {
    mapByte(lowAddress, name + 'L', () => {
      const active = readWord();
      timer.temp = active >>> 8;
      return active & 0xff;
    }, value => { timer.temp = value; }, report, state);
    mapByte(lowAddress + 1, name + 'H', () => timer.temp,
      value => writeWord((value << 8) | timer.temp), report, state);
  };

  const mapTemp = state => mapByte(timer.base + TEMP_OFFSET, 'TEMP', () => timer.temp,
    value => { timer.temp = value; }, timer.onAccess, state);
  const mapPeriod = report => mapWord(timer.base + PERIOD_OFFSET, 'PER', () => timer.per,
    value => { timer.per = value; }, report, () => timer.snapshotPeriod());

  return { mapByte, mapWord, mapTemp, mapPeriod };
}
