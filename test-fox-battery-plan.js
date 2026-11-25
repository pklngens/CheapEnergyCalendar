'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'FoxBatteryManager.gs'), 'utf8');
const weekday = new Date('2026-11-25T00:00:00.000Z');
const weekend = new Date('2026-11-28T00:00:00.000Z');

function createScriptContext(globals = {}) {
  const context = vm.createContext({
    Utilities: {
      formatDate(date, timeZone, format) {
        assert.equal(timeZone, 'UTC');
        switch (format) {
          case 'u':
            return String(date.getUTCDay() || 7);
          case 'H':
            return String(date.getUTCHours());
          case 'm':
            return String(date.getUTCMinutes());
          case 'HH:mm':
            return `${String(date.getUTCHours()).padStart(2, '0')}:` +
              String(date.getUTCMinutes()).padStart(2, '0');
          default:
            throw new Error(`Unexpected date format: ${format}`);
        }
      }
    },
    ...globals
  });
  vm.runInContext(source, context, { filename: 'FoxBatteryManager.gs' });
  return context;
}

function createPrices(date, { overnight = 0.25, midday = 0.10, evening = 0.20 } = {}) {
  return Array.from({ length: 96 }, (_, clockIndex) => {
    const hour = Math.floor(clockIndex / 4);
    const start = new Date(date.getTime() + clockIndex * 15 * 60 * 1000);
    const price = hour < 7
      ? overnight
      : hour >= 10 && hour < 15
        ? midday
        : hour >= 16 && hour < 21
          ? typeof evening === 'function' ? evening(clockIndex) : evening
          : 0.22;
    return {
      start,
      end: new Date(start.getTime() + 15 * 60 * 1000),
      clockIndex,
      price
    };
  });
}

function createPlan(context, prices, soc, date = weekday, middayOnly = true) {
  return context.createFoxBatteryPlan(prices, soc, 'UTC', date, {
    middayOnly,
    notBefore: middayOnly
      ? new Date(date.getTime() + (10 * 60 + 15) * 60 * 1000)
      : undefined
  });
}

function assertPrice(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `Expected ${expected}, got ${actual}`);
}

for (const soc of [85, 100]) {
  test(`weekday midday SoC ${soc}% uses charged thresholds without scheduling a top-up`, () => {
    const plan = createPlan(createScriptContext(), createPrices(weekday), soc);

    assertPrice(plan.minDischargePrice, 0.30);
    assertPrice(plan.eveningDischargePrice, 0.17);
    assert.equal(plan.requiredQuarters, 0);
    assert.equal(plan.middayWindow, null);
    assert.equal(plan.middayTopUpScheduled, false);
    assert.ok(plan.intervals.every(interval => interval.workMode !== 'ForceCharge'));
    assert.equal(plan.intervals[17 * 4].workMode, 'SelfUse');
  });
}

test('a full battery does not apply the extra weekday morning evening-price floor', () => {
  const prices = createPrices(weekday, { overnight: 0.10, midday: 0.20, evening: 0.50 });
  const plan = createPlan(createScriptContext(), prices, 85);

  assertPrice(plan.minDischargePrice, 0.145);
  assert.equal(plan.intervals[10 * 4 + 2].workMode, 'SelfUse');
  assert.equal(plan.intervals[10 * 4 + 3].workMode, 'SelfUse');
});

test('a full battery uses a zero evening floor when the evening average is negative', () => {
  const prices = createPrices(weekday, {
    evening: clockIndex => clockIndex < 19 * 4 ? -0.12 : -0.07
  });
  const plan = createPlan(createScriptContext(), prices, 85);

  assertPrice(plan.eveningDischargePrice, 0);
  assert.equal(plan.intervals[19 * 4].workMode, 'Backup');
  assert.equal(plan.intervals[19 * 4 + 1].workMode, 'Backup');
});

test('anti-chatter still smooths an isolated negative-price quarter', () => {
  const prices = createPrices(weekday, {
    evening: clockIndex => clockIndex >= 19 * 4 && clockIndex <= 20 * 4
      ? clockIndex === 19 * 4 + 2 ? -0.01 : 0.02
      : -0.12
  });
  const plan = createPlan(createScriptContext(), prices, 85);

  assertPrice(plan.eveningDischargePrice, 0);
  assert.equal(plan.intervals[19 * 4 + 1].workMode, 'SelfUse');
  assert.equal(plan.intervals[19 * 4 + 2].workMode, 'SelfUse');
  assert.equal(plan.intervals[19 * 4 + 3].workMode, 'SelfUse');
});

test('below the SoC limit an unprofitable midday top-up keeps the stricter thresholds', () => {
  const prices = createPrices(weekday, { midday: 0.30 });
  const plan = createPlan(createScriptContext(), prices, 84.99);

  assert.equal(plan.middayTopUpScheduled, false);
  assert.notEqual(plan.middayWindow, null);
  assertPrice(plan.minDischargePrice, 0.3375);
  assertPrice(plan.eveningDischargePrice, 0.30);
  assert.ok(plan.intervals.every(interval => interval.workMode !== 'ForceCharge'));
});

test('a full battery in the tomorrow plan does not count as a full midday charge', () => {
  const prices = createPrices(weekday, { midday: 0.30 });
  const plan = createPlan(createScriptContext(), prices, 100, weekday, false);

  assert.equal(plan.middayTopUpScheduled, false);
  assertPrice(plan.minDischargePrice, 0.3375);
  assertPrice(plan.eveningDischargePrice, 0.30);
  assert.ok(plan.intervals.every(interval => interval.workMode !== 'ForceCharge'));
});

test('a profitable top-up still schedules only its actual charging intervals', () => {
  const context = createScriptContext();
  const prices = createPrices(weekday, { midday: 0.20, evening: 0.25 });
  const middayPlan = createPlan(context, prices, 84.99);
  const tomorrowPlan = createPlan(context, prices, 100, weekday, false);

  assert.equal(middayPlan.middayTopUpScheduled, true);
  assert.equal(middayPlan.requiredQuarters, 2);
  assert.deepEqual(
    Array.from(middayPlan.intervals.filter(interval => interval.workMode === 'ForceCharge'),
      interval => interval.clockIndex),
    [42, 43]
  );
  assertPrice(middayPlan.eveningDischargePrice, 0.245);
  assert.equal(tomorrowPlan.middayTopUpScheduled, true);
  assert.equal(tomorrowPlan.requiredQuarters, 0);
  assertPrice(tomorrowPlan.eveningDischargePrice, 0.245);
  assert.deepEqual(
    Array.from(tomorrowPlan.intervals.filter(interval => interval.workMode === 'ForceCharge'),
      interval => interval.clockIndex),
    [40, 41, 42, 43, 44, 45]
  );
});

test('a full midday battery preserves the weekend morning rule', () => {
  const plan = createPlan(createScriptContext(), createPrices(weekend), 85, weekend);

  assertPrice(plan.minDischargePrice, 0.32);
  assertPrice(plan.eveningDischargePrice, 0.17);
  assert.equal(plan.eveningStartHour, 15);
});

test('the schedule log still says no top-up is scheduled for a full battery', () => {
  const logs = [];
  const writes = [];
  const properties = {
    FOX_API_KEY: 'test-key',
    FOX_DEVICE_SN: 'test-device',
    FOX_FD_POWER_W: '1200'
  };
  const context = createScriptContext({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: name => properties[name] ?? null })
    },
    Logger: { log: message => logs.push(message) }
  });
  context.getFoxBatteryTimeZone = () => 'UTC';
  context.getFoxTodayBounds = () => ({ date: '2026-11-25', start: weekday });
  context.fetchFoxEnergyZeroPrices = () => createPrices(weekday);
  context.getFoxBatterySoc = () => 85;
  context.foxApiPost = (endpoint, apiKey, payload) => {
    if (endpoint === '/op/v3/device/scheduler/get') {
      return {
        maxGroupCount: 96,
        properties: { workmode: { enumList: ['SelfUse', 'Backup', 'ForceCharge'] } }
      };
    }
    assert.equal(endpoint, '/op/v3/device/scheduler/enable');
    writes.push(payload);
    return {};
  };

  context.updateFoxChargeSchedule(true);

  assert.equal(writes.length, 1);
  assert.ok(writes[0].groups.every(group => group.workMode !== 'ForceCharge'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /morning discharge threshold 0\.3000 EUR\/kWh/);
  assert.match(logs[0], /after-17:00 threshold 0\.1700 EUR\/kWh/);
  assert.match(logs[0], /midday top-up not scheduled\.$/);
});
