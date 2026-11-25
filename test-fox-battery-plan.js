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
        : hour >= 17 && hour < 22
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

function createPlan(context, prices, soc, date = weekday, middayOnly = true, options = {}) {
  return context.createFoxBatteryPlan(prices, soc, 'UTC', date, {
    middayOnly,
    notBefore: middayOnly
      ? new Date(date.getTime() + (10 * 60 + 15) * 60 * 1000)
      : undefined,
    ...options
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

test('required charge quarters scale with battery capacity and force power', () => {
  const context = createScriptContext();
  const prices = createPrices(weekday);
  const configurations = [
    { batteryCapacityWh: 2400, forcePowerWatts: 1200, expectedQuarters: 8 },
    { batteryCapacityWh: 5120, forcePowerWatts: 2000, expectedQuarters: 11 }
  ];

  configurations.forEach(configuration => {
    const { expectedQuarters, ...options } = configuration;
    const plan = createPlan(context, prices, 10, weekday, false, options);
    assert.equal(plan.requiredQuarters, expectedQuarters);
  });
});

test('a skipped charge uses a capacity-scaled full-charge reference window', () => {
  const prices = createPrices(weekday).map(interval => ({
    ...interval,
    price: interval.clockIndex < 28
      ? (interval.clockIndex + 1) / 100
      : interval.price
  }));
  const plan = createPlan(createScriptContext(), prices, 85, weekday, false, {
    batteryCapacityWh: 5120,
    forcePowerWatts: 2000
  });

  assert.equal(plan.requiredQuarters, 0);
  assertPrice(plan.averageChargePrice, 0.06);
});

test('the schedule log still says no top-up is scheduled for a full battery', () => {
  const logs = [];
  const writes = [];
  const reportedMaxGroupCount = 96;
  let lockReleased = false;
  const properties = {
    FOX_API_KEY: 'test-key',
    FOX_DEVICE_SN: 'test-device',
    FOX_FD_POWER_W: '1200',
    FOX_BATTERY_CAPACITY_WH: '2400'
  };
  const context = createScriptContext({
    LockService: {
      getScriptLock: () => ({
        tryLock: timeout => {
          assert.equal(timeout, 30000);
          return true;
        },
        releaseLock: () => {
          lockReleased = true;
        }
      })
    },
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
        maxGroupCount: reportedMaxGroupCount,
        properties: { workmode: { enumList: ['SelfUse', 'Backup', 'ForceCharge'] } }
      };
    }
    assert.equal(endpoint, '/op/v3/device/scheduler/enable');
    writes.push(payload);
    return {};
  };

  context.updateFoxChargeSchedule(true);

  assert.equal(lockReleased, true);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].groups.every(group => group.workMode !== 'ForceCharge'));
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes(`/${reportedMaxGroupCount} group(s)`));
  assert.match(logs[0], /morning discharge threshold 0\.3000 EUR\/kWh/);
  assert.match(logs[0], /after-17:00 threshold 0\.1700 EUR\/kWh/);
  assert.match(logs[0], /midday top-up not scheduled\.$/);
});

test('a missing or invalid battery capacity rejects the schedule update', () => {
  for (const batteryCapacity of [null, '', '0', '-2400', 'Infinity', 'NaN']) {
    const properties = {
      FOX_API_KEY: 'test-key',
      FOX_DEVICE_SN: 'test-device',
      FOX_FD_POWER_W: '1200',
      FOX_BATTERY_CAPACITY_WH: batteryCapacity
    };
    const context = createScriptContext({
      LockService: {
        getScriptLock: () => ({
          tryLock: () => true,
          releaseLock: () => {}
        })
      },
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: name => properties[name] ?? null })
      }
    });
    context.getFoxBatteryTimeZone = () => 'UTC';

    assert.throws(
      () => context.updateFoxChargeSchedule(false),
      /FOX_BATTERY_CAPACITY_WH must be set .* positive finite number/
    );
  }
});

test('a locked schedule update logs a warning and returns without processing', () => {
  const logs = [];
  let processingStarted = false;
  const context = createScriptContext({
    LockService: {
      getScriptLock: () => ({
        tryLock: timeout => {
          assert.equal(timeout, 30000);
          return false;
        },
        releaseLock: () => assert.fail('A lock that was not acquired must not be released')
      })
    },
    Logger: { log: message => logs.push(message) }
  });
  context.getFoxBatteryTimeZone = () => {
    processingStarted = true;
  };

  assert.doesNotThrow(() => context.updateFoxChargeSchedule(false));

  assert.equal(processingStarted, false);
  assert.match(logs[0], /Warning: Fox ESS schedule update skipped/);
});

test('the script lock is released when schedule processing throws', () => {
  let lockReleased = false;
  const context = createScriptContext({
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {
          lockReleased = true;
        }
      })
    }
  });
  context.getFoxBatteryTimeZone = () => {
    throw new Error('test failure');
  };

  assert.throws(() => context.updateFoxChargeSchedule(false), /test failure/);
  assert.equal(lockReleased, true);
});

test('fetchFoxWithRetry retries transient HTTP responses with exponential backoff', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let attempts = 0;
    const delays = [];
    const logs = [];
    const context = createScriptContext({
      UrlFetchApp: {
        fetch: () => {
          attempts++;
          const responseStatus = attempts === 1 ? status : 200;
          return { getResponseCode: () => responseStatus };
        }
      },
      Utilities: { sleep: delayMs => delays.push(delayMs) },
      Logger: { log: message => logs.push(message) }
    });

    const response = context.fetchFoxWithRetry('https://example.test', {}, 3, 100);

    assert.equal(response.getResponseCode(), 200);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [100]);
    assert.match(logs[0], /attempt 2 of 3/);
  }
});

test('fetchFoxWithRetry retries network exceptions and rethrows after the final attempt', () => {
  let attempts = 0;
  const delays = [];
  const context = createScriptContext({
    UrlFetchApp: {
      fetch: () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('network failure');
        }
        return { getResponseCode: () => 200 };
      }
    },
    Utilities: { sleep: delayMs => delays.push(delayMs) },
    Logger: { log: () => {} }
  });

  assert.equal(context.fetchFoxWithRetry('https://example.test', {}, 3, 100)
    .getResponseCode(), 200);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);

  let failedAttempts = 0;
  const failedDelays = [];
  const failedContext = createScriptContext({
    UrlFetchApp: {
      fetch: () => {
        failedAttempts++;
        throw new Error('network failure');
      }
    },
    Utilities: { sleep: delayMs => failedDelays.push(delayMs) },
    Logger: { log: () => {} }
  });
  assert.throws(
    () => failedContext.fetchFoxWithRetry('https://example.test', {}, 2, 100),
    /network failure/
  );
  assert.equal(failedAttempts, 2);
  assert.deepEqual(failedDelays, [100]);
});

test('fetchFoxWithRetry does not retry non-transient HTTP responses', () => {
  for (const status of [400, 401, 403, 404]) {
    let attempts = 0;
    const context = createScriptContext({
      UrlFetchApp: {
        fetch: () => {
          attempts++;
          return { getResponseCode: () => status };
        }
      },
      Utilities: { sleep: () => assert.fail('A permanent response must not be retried') },
      Logger: { log: () => assert.fail('A permanent response must not be logged as a retry') }
    });

    assert.equal(context.fetchFoxWithRetry('https://example.test', {}).getResponseCode(), status);
    assert.equal(attempts, 1);
  }
});
