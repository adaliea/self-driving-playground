#!/usr/bin/env node

const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = require('node:fs').readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  DEFAULT_SETTINGS,
  FIXED_TIMESTEP,
  ROAD_LANE_COUNT,
  ROAD_LANE_WIDTH,
  Simulation,
} = require(path.resolve(__dirname, '../src/simulation/index.ts'));

const args = parseArgs(process.argv.slice(2));
const seconds = numberArg(args.seconds, 90);
const warmup = numberArg(args.warmup, 15);
const seedStart = numberArg(args.seed, 42);
const runs = numberArg(args.runs, 3);
const density = numberArg(args.density, 0.9);
const startSpeed = numberArg(args['start-speed'] ?? args.startSpeed, 24);
const noisyLaneLines = booleanArg(args['noisy-lanes'] ?? args.noisyLaneLines ?? args.noisy, false);
const noisyVehicles = booleanArg(args['noisy-vehicles'] ?? args.noisyVehicles ?? args.noisy, false);
const actuatorVariation = booleanArg(args['actuator-variation'] ?? args.actuatorVariation, false);
const json = Boolean(args.json);

const reports = [];
for (let run = 0; run < runs; run += 1) {
  reports.push(runScenario(seedStart + run * 101, density, seconds, warmup, startSpeed));
}

const summary = summarizeReports(reports);
if (json) {
  console.log(JSON.stringify({ runs: reports, summary }, null, 2));
} else {
  printReport(reports, summary);
}

function runScenario(seed, trafficDensity, durationSeconds, warmupSeconds, egoStartSpeed) {
  const settings = {
    ...DEFAULT_SETTINGS,
    seed,
    trafficDensity,
    startingSpeed: egoStartSpeed,
    noisyLaneLines,
    noisyVehicles,
    actuatorVariation,
    steerAssist: true,
    accelerateAssist: true,
    debugOverlays: false,
  };
  const simulation = new Simulation(settings);
  const steps = Math.round(durationSeconds / FIXED_TIMESTEP);
  const warmupSteps = Math.round(warmupSeconds / FIXED_TIMESTEP);
  const previous = new Map();
  const laneChanges = new Map();
  const hardBrakes = new Map();
  const previousSample = new Map();
  const passEvents = [];
  const samples = [];

  for (let step = 0; step < steps; step += 1) {
    const input = simulation.createEgoInput(settings, FIXED_TIMESTEP);
    simulation.step(FIXED_TIMESTEP, { motor: 0, steering: 0 }, settings);
    const state = simulation.getDebugState();
    const ego = state.vehicles.find((vehicle) => vehicle.kind === 'ego');
    if (!ego) throw new Error('Missing ego vehicle in debug state.');

    for (const vehicle of state.vehicles) {
      if (vehicle.kind !== 'traffic') continue;
      const prev = previous.get(vehicle.id);
      if (prev) {
        const relativeBefore = prev.s - prev.egoS;
        const relativeNow = vehicle.s - ego.s;
        if (relativeBefore < 0 && relativeNow >= 0) {
          passEvents.push({ time: state.time, personality: vehicle.personality ?? 'Unknown' });
        }
        if (prev.laneIndex !== vehicle.laneIndex) {
          laneChanges.set(vehicle.personality ?? 'Unknown', (laneChanges.get(vehicle.personality ?? 'Unknown') ?? 0) + 1);
        }
        const accel = (vehicle.speed - prev.speed) / FIXED_TIMESTEP;
        const isHardBraking = accel < -3.2;
        if (isHardBraking && !prev.hardBraking) {
          hardBrakes.set(vehicle.personality ?? 'Unknown', (hardBrakes.get(vehicle.personality ?? 'Unknown') ?? 0) + 1);
        }
      }
      previous.set(vehicle.id, {
        s: vehicle.s,
        speed: vehicle.speed,
        laneIndex: vehicle.laneIndex,
        egoS: ego.s,
        hardBraking: previous.get(vehicle.id)
          ? (vehicle.speed - previous.get(vehicle.id).speed) / FIXED_TIMESTEP < -2.2
          : false,
      });
    }

    if (step >= warmupSteps && step % 10 === 0) {
      samples.push(sampleState(state, previousSample));
      updateSamplePrevious(state, previousSample);
    }
  }

  return finalizeRun(seed, density, seconds, warmup, samples, passEvents, laneChanges, hardBrakes);
}

function sampleState(state, previousSample) {
  const ego = state.vehicles.find((vehicle) => vehicle.kind === 'ego');
  const traffic = state.vehicles.filter((vehicle) => vehicle.kind === 'traffic');
  const speeds = traffic.map((vehicle) => vehicle.speed);
  const gaps = [];
  const byPersonality = new Map();
  const byModel = new Map();
  const laneKeeping = createLaneKeepingAccumulator();
  const egoLaneKeeping = createLaneKeepingAccumulator();
  const sortedTraffic = [...traffic].sort((a, b) => a.s - b.s);

  for (let behindIndex = 0; behindIndex < sortedTraffic.length; behindIndex += 1) {
    const behind = sortedTraffic[behindIndex];
    for (let aheadIndex = behindIndex + 1; aheadIndex < sortedTraffic.length; aheadIndex += 1) {
      const ahead = sortedTraffic[aheadIndex];
      const stationGap = ahead.s - behind.s;
      if (stationGap > 80) break;

      const lateralGap = Math.abs(ahead.lateral - behind.lateral);
      const bodyHalfWidth = ((behind.width ?? 2) + (ahead.width ?? 2)) / 2;
      if (lateralGap > bodyHalfWidth + 0.55) continue;

      const bodyHalfLength = ((behind.length ?? 4.7) + (ahead.length ?? 4.7)) / 2;
      gaps.push(stationGap - bodyHalfLength);
    }
  }

  for (const vehicle of traffic) {
    const key = vehicle.personality ?? 'Unknown';
    const bucket = byPersonality.get(key) ?? { count: 0, speedSum: 0, laneKeeping: createLaneKeepingAccumulator() };
    bucket.count += 1;
    bucket.speedSum += vehicle.speed;
    addLaneKeepingSample(bucket.laneKeeping, vehicle, previousSample.get(vehicle.id));
    addLaneKeepingSample(laneKeeping, vehicle, previousSample.get(vehicle.id));
    byPersonality.set(key, bucket);

    const modelKey = laneModelLabel(vehicle.laneControlModel);
    const modelBucket = byModel.get(modelKey) ?? { count: 0, speedSum: 0, laneKeeping: createLaneKeepingAccumulator() };
    modelBucket.count += 1;
    modelBucket.speedSum += vehicle.speed;
    addLaneKeepingSample(modelBucket.laneKeeping, vehicle, previousSample.get(vehicle.id));
    byModel.set(modelKey, modelBucket);
  }

  if (ego) {
    addLaneKeepingSample(egoLaneKeeping, ego, previousSample.get(ego.id));
  }

  return {
    time: state.time,
    collisions: state.collisions,
    trafficCount: traffic.length,
    speedMean: mean(speeds),
    speedStd: stddev(speeds),
    gapMean: mean(gaps),
    gapMin: gaps.length ? Math.min(...gaps) : 0,
    stoppedFraction: speeds.length ? speeds.filter((speed) => speed < 5).length / speeds.length : 0,
    laneKeeping,
    egoLaneKeeping,
    byPersonality,
    byModel,
  };
}

function finalizeRun(seed, density, seconds, warmup, samples, passEvents, laneChanges, hardBrakes) {
  const personality = new Map();
  const model = new Map();
  for (const sample of samples) {
    for (const [label, bucket] of sample.byPersonality.entries()) {
      const current = personality.get(label) ?? {
        samples: 0,
        countSum: 0,
        speedSum: 0,
        laneKeeping: createLaneKeepingAccumulator(),
      };
      current.samples += 1;
      current.countSum += bucket.count;
      current.speedSum += bucket.speedSum / Math.max(1, bucket.count);
      mergeLaneKeeping(current.laneKeeping, bucket.laneKeeping);
      personality.set(label, current);
    }

    for (const [label, bucket] of sample.byModel.entries()) {
      const current = model.get(label) ?? {
        samples: 0,
        countSum: 0,
        speedSum: 0,
        laneKeeping: createLaneKeepingAccumulator(),
      };
      current.samples += 1;
      current.countSum += bucket.count;
      current.speedSum += bucket.speedSum / Math.max(1, bucket.count);
      mergeLaneKeeping(current.laneKeeping, bucket.laneKeeping);
      model.set(label, current);
    }
  }

  const personalitySummary = [...personality.entries()]
    .map(([label, bucket]) => ({
      label,
      avgCount: bucket.countSum / Math.max(1, bucket.samples),
      avgSpeedMph: mpsToMph(bucket.speedSum / Math.max(1, bucket.samples)),
      laneKeeping: summarizeLaneKeeping(bucket.laneKeeping),
      laneChanges: laneChanges.get(label) ?? 0,
      hardBrakes: hardBrakes.get(label) ?? 0,
    }))
    .sort((a, b) => b.avgCount - a.avgCount);

  const modelSummary = [...model.entries()]
    .map(([label, bucket]) => ({
      label,
      avgCount: bucket.countSum / Math.max(1, bucket.samples),
      avgSpeedMph: mpsToMph(bucket.speedSum / Math.max(1, bucket.samples)),
      laneKeeping: summarizeLaneKeeping(bucket.laneKeeping),
    }))
    .sort((a, b) => b.avgCount - a.avgCount);

  const laneKeeping = createLaneKeepingAccumulator();
  const egoLaneKeeping = createLaneKeepingAccumulator();
  for (const sample of samples) mergeLaneKeeping(laneKeeping, sample.laneKeeping);
  for (const sample of samples) mergeLaneKeeping(egoLaneKeeping, sample.egoLaneKeeping);
  const speedStdMph = mpsToMph(mean(samples.map((sample) => sample.speedStd)));
  const stoppedFraction = mean(samples.map((sample) => sample.stoppedFraction));
  const flowPerMinute = passEvents.length / Math.max(0.01, (seconds - warmup) / 60);
  const collisionDelta = samples.length ? samples[samples.length - 1].collisions - samples[0].collisions : 0;

  return {
    seed,
    density,
    seconds,
    warmup,
    avgTrafficCount: mean(samples.map((sample) => sample.trafficCount)),
    avgSpeedMph: mpsToMph(mean(samples.map((sample) => sample.speedMean))),
    speedStdMph,
    waveIndex: speedStdMph * (1 + stoppedFraction * 3),
    avgGapMeters: mean(samples.map((sample) => sample.gapMean)),
    minGapMeters: Math.min(...samples.map((sample) => sample.gapMin).filter((gap) => gap > 0)),
    laneKeeping: summarizeLaneKeeping(laneKeeping),
    egoLaneKeeping: summarizeLaneKeeping(egoLaneKeeping),
    stoppedFraction,
    flowPerMinute,
    collisionDelta,
    modelSummary,
    personalitySummary,
  };
}

function summarizeReports(reports) {
  return {
    runs: reports.length,
    avgTrafficCount: mean(reports.map((report) => report.avgTrafficCount)),
    avgSpeedMph: mean(reports.map((report) => report.avgSpeedMph)),
    speedStdMph: mean(reports.map((report) => report.speedStdMph)),
    waveIndex: mean(reports.map((report) => report.waveIndex)),
    avgGapMeters: mean(reports.map((report) => report.avgGapMeters)),
    minGapMeters: Math.min(...reports.map((report) => report.minGapMeters)),
    laneErrorRmsMeters: mean(reports.map((report) => report.laneKeeping.laneErrorRmsMeters)),
    headingRmsDegrees: mean(reports.map((report) => report.laneKeeping.headingRmsDegrees)),
    steeringRateMean: mean(reports.map((report) => report.laneKeeping.steeringRateMean)),
    laneExcursionPct: mean(reports.map((report) => report.laneKeeping.laneExcursionPct)),
    laneChangePct: mean(reports.map((report) => report.laneKeeping.laneChangePct)),
    assignedLaneExitPct: mean(reports.map((report) => report.laneKeeping.assignedLaneExitPct)),
    roadExitPct: mean(reports.map((report) => report.laneKeeping.roadExitPct)),
    maxRoadOverrunMeters: Math.max(...reports.map((report) => report.laneKeeping.maxRoadOverrunMeters)),
    egoLaneErrorRmsMeters: mean(reports.map((report) => report.egoLaneKeeping.laneErrorRmsMeters)),
    egoHeadingRmsDegrees: mean(reports.map((report) => report.egoLaneKeeping.headingRmsDegrees)),
    egoAssignedLaneExitPct: mean(reports.map((report) => report.egoLaneKeeping.assignedLaneExitPct)),
    egoRoadExitPct: mean(reports.map((report) => report.egoLaneKeeping.roadExitPct)),
    stoppedFraction: mean(reports.map((report) => report.stoppedFraction)),
    flowPerMinute: mean(reports.map((report) => report.flowPerMinute)),
    collisions: reports.reduce((total, report) => total + report.collisionDelta, 0),
  };
}

function printReport(reports, summary) {
  console.log('Traffic personality report');
  console.log('==========================');
  console.log(
    `runs=${summary.runs} density=${density.toFixed(2)} seconds=${seconds} warmup=${warmup} startSpeed=${startSpeed} m/s ` +
      `noisyLanes=${noisyLaneLines} noisyVehicles=${noisyVehicles} actuatorVariation=${actuatorVariation}`,
  );
  console.log(
    `avg cars=${summary.avgTrafficCount.toFixed(1)} avg speed=${summary.avgSpeedMph.toFixed(1)} mph ` +
      `speed std=${summary.speedStdMph.toFixed(1)} mph wave=${summary.waveIndex.toFixed(1)}`,
  );
  console.log(
    `avg clear=${summary.avgGapMeters.toFixed(1)} m min clear=${summary.minGapMeters.toFixed(1)} m ` +
      `stopped=${(summary.stoppedFraction * 100).toFixed(1)}% flow=${summary.flowPerMinute.toFixed(1)} veh/min collisions=${summary.collisions}`,
  );
  console.log(
    `lane rms=${summary.laneErrorRmsMeters.toFixed(2)} m heading rms=${summary.headingRmsDegrees.toFixed(1)} deg ` +
      `steer rate=${summary.steeringRateMean.toFixed(2)}/s excursions=${summary.laneExcursionPct.toFixed(1)}%`,
  );
  console.log(
    `lane-change=${summary.laneChangePct.toFixed(1)}% assigned-exit=${summary.assignedLaneExitPct.toFixed(1)}% ` +
      `offroad=${summary.roadExitPct.toFixed(1)}% max offroad=${summary.maxRoadOverrunMeters.toFixed(2)} m`,
  );
  console.log(
    `ego assist lane rms=${summary.egoLaneErrorRmsMeters.toFixed(2)} m heading rms=${summary.egoHeadingRmsDegrees.toFixed(1)} deg ` +
      `assigned-exit=${summary.egoAssignedLaneExitPct.toFixed(1)}% offroad=${summary.egoRoadExitPct.toFixed(1)}%`,
  );

  for (const report of reports) {
    console.log('');
    console.log(`seed ${report.seed}`);
    console.log(
      `  cars=${report.avgTrafficCount.toFixed(1)} speed=${report.avgSpeedMph.toFixed(1)} mph ` +
        `wave=${report.waveIndex.toFixed(1)} flow=${report.flowPerMinute.toFixed(1)} veh/min collisions=${report.collisionDelta}`,
    );
    for (const model of report.modelSummary) {
      console.log(
        `  model ${model.label.padEnd(7)} count=${model.avgCount.toFixed(1).padStart(5)} ` +
          `laneRms=${model.laneKeeping.laneErrorRmsMeters.toFixed(2).padStart(4)}m ` +
          `head=${model.laneKeeping.headingRmsDegrees.toFixed(1).padStart(4)}deg ` +
          `steer=${model.laneKeeping.steeringRateMean.toFixed(2).padStart(4)}/s ` +
          `exit=${model.laneKeeping.assignedLaneExitPct.toFixed(1).padStart(4)}% ` +
          `off=${model.laneKeeping.roadExitPct.toFixed(1).padStart(4)}%`,
      );
    }
    for (const personality of report.personalitySummary) {
      console.log(
        `  ${personality.label.padEnd(10)} count=${personality.avgCount.toFixed(1).padStart(5)} ` +
          `speed=${personality.avgSpeedMph.toFixed(1).padStart(5)} mph ` +
          `laneRms=${personality.laneKeeping.laneErrorRmsMeters.toFixed(2).padStart(4)}m ` +
          `head=${personality.laneKeeping.headingRmsDegrees.toFixed(1).padStart(4)}deg ` +
          `exc=${personality.laneKeeping.laneExcursionPct.toFixed(1).padStart(4)}% ` +
          `exit=${personality.laneKeeping.assignedLaneExitPct.toFixed(1).padStart(4)}% ` +
          `off=${personality.laneKeeping.roadExitPct.toFixed(1).padStart(4)}% ` +
          `laneChanges=${String(personality.laneChanges).padStart(4)} hardBrakes=${String(personality.hardBrakes).padStart(4)}`,
      );
    }
  }

  console.log('');
  console.log('Tuning hints');
  if (summary.collisions > 0 || summary.minGapMeters < 0.75) {
    console.log('- Safety is too tight: raise minGap/timeHeadway or brakeGain for Tailgater/Assertive.');
  }
  if (summary.waveIndex < 6 && density > 0.75) {
    console.log('- Waves are weak: increase slow-pocket probability, tailgater share, or speed variance.');
  }
  if (summary.waveIndex > 18) {
    console.log('- Waves are severe: reduce tailgater share, raise headway, or lower lane-change eagerness.');
  }
  if (summary.flowPerMinute < 25 && density > 0.75) {
    console.log('- Throughput is low: reduce truck/cautious share or increase desired speeds.');
  }
  if (summary.laneErrorRmsMeters > 0.42 || summary.headingRmsDegrees > 4 || summary.laneExcursionPct > 4) {
    console.log('- Lane keeping is unstable: lower steeringGain/headingGain or increase steering actuator smoothing for the worst personalities.');
  }
  if (summary.assignedLaneExitPct > 1.5) {
    console.log('- Vehicles are leaving assigned lanes outside planned changes: lower lateral gains or lane-change eagerness for the worst personalities.');
  }
  if (summary.roadExitPct > 0) {
    console.log('- Vehicles are leaving the road: strengthen road-edge recovery or reduce outer-lane lane-change aggressiveness.');
  }
}

function updateSamplePrevious(state, previousSample) {
  const previous = new Map(previousSample);
  previousSample.clear();
  for (const vehicle of state.vehicles) {
    const activeLaneChange = isActiveLaneChange(vehicle, previous.get(vehicle.id));
    previousSample.set(vehicle.id, {
      lateral: vehicle.lateral,
      headingOffset: vehicle.headingOffset,
      actualSteering: vehicle.actualSteering,
      targetLane: vehicle.targetLane,
      activeLaneChange,
      laneControlModel: vehicle.laneControlModel,
    });
  }
}

function createLaneKeepingAccumulator() {
  return {
    samples: 0,
    laneErrorSq: 0,
    headingSq: 0,
    steeringSq: 0,
    steeringRateAbs: 0,
    steeringRateSamples: 0,
    laneExcursions: 0,
    trackingSamples: 0,
    laneChangeSamples: 0,
    assignedLaneExitSamples: 0,
    roadExitSamples: 0,
    maxRoadOverrunMeters: 0,
  };
}

function addLaneKeepingSample(bucket, vehicle, previous) {
  const targetCenter = laneCenter(vehicle.targetLane);
  const laneError = vehicle.lateral - targetCenter;
  const activeLaneChange = isActiveLaneChange(vehicle, previous);
  const assignedLaneExit = vehicleBodyExitsAssignedLane(vehicle, laneError);
  const roadOverrun = vehicleRoadOverrun(vehicle);
  const holdingLane = !activeLaneChange;

  bucket.trackingSamples += 1;
  if (activeLaneChange) bucket.laneChangeSamples += 1;
  if (!activeLaneChange && assignedLaneExit) bucket.assignedLaneExitSamples += 1;
  if (roadOverrun > 0) {
    bucket.roadExitSamples += 1;
    bucket.maxRoadOverrunMeters = Math.max(bucket.maxRoadOverrunMeters, roadOverrun);
  }

  if (holdingLane) {
    bucket.samples += 1;
    bucket.laneErrorSq += laneError * laneError;
    bucket.headingSq += vehicle.headingOffset * vehicle.headingOffset;
    bucket.steeringSq += vehicle.actualSteering * vehicle.actualSteering;
    if (Math.abs(laneError) > ROAD_LANE_WIDTH * 0.32) bucket.laneExcursions += 1;
  }

  if (holdingLane && previous && previous.targetLane === vehicle.targetLane) {
    const sampleDt = FIXED_TIMESTEP * 10;
    bucket.steeringRateAbs += Math.abs(vehicle.actualSteering - previous.actualSteering) / sampleDt;
    bucket.steeringRateSamples += 1;
  }
}

function mergeLaneKeeping(target, source) {
  target.samples += source.samples;
  target.laneErrorSq += source.laneErrorSq;
  target.headingSq += source.headingSq;
  target.steeringSq += source.steeringSq;
  target.steeringRateAbs += source.steeringRateAbs;
  target.steeringRateSamples += source.steeringRateSamples;
  target.laneExcursions += source.laneExcursions;
  target.trackingSamples += source.trackingSamples;
  target.laneChangeSamples += source.laneChangeSamples;
  target.assignedLaneExitSamples += source.assignedLaneExitSamples;
  target.roadExitSamples += source.roadExitSamples;
  target.maxRoadOverrunMeters = Math.max(target.maxRoadOverrunMeters, source.maxRoadOverrunMeters);
}

function summarizeLaneKeeping(bucket) {
  return {
    samples: bucket.samples,
    laneErrorRmsMeters: Math.sqrt(bucket.laneErrorSq / Math.max(1, bucket.samples)),
    headingRmsDegrees: radiansToDegrees(Math.sqrt(bucket.headingSq / Math.max(1, bucket.samples))),
    steeringRms: Math.sqrt(bucket.steeringSq / Math.max(1, bucket.samples)),
    steeringRateMean: bucket.steeringRateAbs / Math.max(1, bucket.steeringRateSamples),
    laneExcursionPct: (bucket.laneExcursions / Math.max(1, bucket.samples)) * 100,
    laneChangePct: (bucket.laneChangeSamples / Math.max(1, bucket.trackingSamples)) * 100,
    assignedLaneExitPct: (bucket.assignedLaneExitSamples / Math.max(1, bucket.trackingSamples)) * 100,
    roadExitPct: (bucket.roadExitSamples / Math.max(1, bucket.trackingSamples)) * 100,
    maxRoadOverrunMeters: bucket.maxRoadOverrunMeters,
  };
}

function isActiveLaneChange(vehicle, previous) {
  const targetCenter = laneCenter(vehicle.targetLane);
  const laneError = vehicle.lateral - targetCenter;
  const targetChanged = previous && previous.targetLane !== vehicle.targetLane;
  const settledInTargetLane = vehicle.laneIndex === vehicle.targetLane && Math.abs(laneError) < 0.42 && Math.abs(vehicle.headingOffset) < 0.07;

  return Boolean(targetChanged || vehicle.laneIndex !== vehicle.targetLane || (previous?.activeLaneChange && !settledInTargetLane));
}

function vehicleBodyExitsAssignedLane(vehicle, laneError) {
  const halfWidth = (vehicle.width ?? 2) / 2;
  return Math.abs(laneError) + halfWidth > ROAD_LANE_WIDTH / 2 + 0.05;
}

function vehicleRoadOverrun(vehicle) {
  const roadHalfWidth = (ROAD_LANE_COUNT * ROAD_LANE_WIDTH) / 2;
  const halfWidth = (vehicle.width ?? 2) / 2;
  return Math.max(0, Math.abs(vehicle.lateral) + halfWidth - roadHalfWidth);
}

function laneModelLabel(model) {
  return model === 'lateralVelocity' ? 'LatVel' : 'Clamped';
}

function laneCenter(laneIndex) {
  return (laneIndex - (ROAD_LANE_COUNT - 1) / 2) * ROAD_LANE_WIDTH;
}

function radiansToDegrees(radians) {
  return radians * (180 / Math.PI);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanArg(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
  return Boolean(value);
}

function mean(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function stddev(values) {
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function mpsToMph(speed) {
  return speed * 2.2369362921;
}
