import type { LaneLineSample, VehicleMeasurement, VehicleTrack } from '../types';
import type { CollisionKind, RenderPoint, RenderSnapshot, RenderVehicle } from './types';

interface ScreenPoint {
  x: number;
  y: number;
}

export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2D canvas rendering is not available.');
    this.ctx = context;
    this.resize();
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.width = Math.max(1, Math.floor(bounds.width));
    this.height = Math.max(1, Math.floor(bounds.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  render(snapshot: RenderSnapshot): void {
    const ctx = this.ctx;
    const scale = this.scale;

    ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackground(snapshot);
    this.drawRoad(snapshot);
    this.drawLaneSamples(snapshot, scale);
    this.drawVehicles(snapshot);
    this.drawDetections(snapshot, scale);
    this.drawCollisionEffects(snapshot);
    this.drawPerceptionLegend(snapshot);
    this.drawControlOverlay(snapshot);
    this.drawEgoCollisionFeedback(snapshot);
  }

  private get scale(): number {
    return Math.max(4.2, Math.min(7.4, this.height / 122));
  }

  private drawBackground(snapshot: RenderSnapshot): void {
    const ctx = this.ctx;
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, '#071013');
    gradient.addColorStop(0.58, '#0a1417');
    gradient.addColorStop(1, '#04090b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawWorldGrid(snapshot);
  }

  private drawWorldGrid(snapshot: RenderSnapshot): void {
    const ctx = this.ctx;
    const spacing = 25;
    const radius = 220;
    const startX = Math.floor((snapshot.camera.x - radius) / spacing) * spacing;
    const endX = Math.ceil((snapshot.camera.x + radius) / spacing) * spacing;
    const startY = Math.floor((snapshot.camera.y - radius) / spacing) * spacing;
    const endY = Math.ceil((snapshot.camera.y + radius) / spacing) * spacing;

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(69, 122, 130, 0.18)';

    for (let x = startX; x <= endX; x += spacing) {
      const a = this.worldToScreen({ x, y: startY }, snapshot);
      const b = this.worldToScreen({ x, y: endY }, snapshot);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (let y = startY; y <= endY; y += spacing) {
      const a = this.worldToScreen({ x: startX, y }, snapshot);
      const b = this.worldToScreen({ x: endX, y }, snapshot);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(109, 247, 209, 0.22)';
    for (let x = Math.ceil(startX / (spacing * 2)) * spacing * 2; x <= endX; x += spacing * 2) {
      for (let y = Math.ceil(startY / (spacing * 2)) * spacing * 2; y <= endY; y += spacing * 2) {
        const point = this.worldToScreen({ x, y }, snapshot);
        if (point.x < -12 || point.x > this.width + 12 || point.y < -12 || point.y > this.height + 12) continue;
        ctx.beginPath();
        ctx.moveTo(point.x - 4, point.y);
        ctx.lineTo(point.x + 4, point.y);
        ctx.moveTo(point.x, point.y - 4);
        ctx.lineTo(point.x, point.y + 4);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  private drawRoad(snapshot: RenderSnapshot): void {
    const ctx = this.ctx;
    const left = snapshot.road.surface.left.map((point) => this.worldToScreen(point, snapshot));
    const right = snapshot.road.surface.right.map((point) => this.worldToScreen(point, snapshot));

    ctx.save();
    ctx.beginPath();
    left.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    [...right].reverse().forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.fillStyle = '#111a1d';
    ctx.fill();

    const roadGlow = ctx.createLinearGradient(this.width / 2, 0, this.width / 2, this.height);
    roadGlow.addColorStop(0, 'rgba(109, 247, 209, 0.12)');
    roadGlow.addColorStop(0.5, 'rgba(137, 169, 255, 0.05)');
    roadGlow.addColorStop(1, 'rgba(109, 247, 209, 0.02)');
    ctx.fillStyle = roadGlow;
    ctx.fill();
    ctx.restore();

    for (const line of snapshot.road.lines) {
      const points = line.points.map((point) => this.worldToScreen(point, snapshot));
      ctx.save();
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.lineWidth = line.role === 'outer' ? 2.2 : 1.5;
      ctx.strokeStyle = line.role === 'outer' ? 'rgba(225, 247, 245, 0.72)' : 'rgba(220, 242, 240, 0.52)';
      ctx.shadowColor = line.role === 'outer' ? 'rgba(109, 247, 209, 0.22)' : 'rgba(255,255,255,0.12)';
      ctx.shadowBlur = line.role === 'outer' ? 12 : 7;
      if (line.dashed) {
        const dashPattern = [18, 16];
        ctx.setLineDash(dashPattern);
        ctx.lineDashOffset = (line.dashOffsetMeters * this.scale) % (dashPattern[0] + dashPattern[1]);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawVehicles(snapshot: RenderSnapshot): void {
    const sorted = [...snapshot.vehicles].sort((a, b) => (a.kind === 'ego' ? 1 : 0) - (b.kind === 'ego' ? 1 : 0));
    for (const vehicle of sorted) this.drawVehicle(snapshot, vehicle);
  }

  private drawVehicle(snapshot: RenderSnapshot, vehicle: RenderVehicle): void {
    const ctx = this.ctx;
    const screen = this.worldToScreen(vehicle, snapshot);
    const scale = this.scale;
    const width = vehicle.width * scale;
    const length = vehicle.length * scale;
    const relativeHeading = vehicle.heading - snapshot.camera.heading;
    const impactIntensity = this.vehicleImpactIntensity(snapshot, vehicle.id);

    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(relativeHeading);

    ctx.shadowBlur = impactIntensity > 0 ? 16 + impactIntensity * 24 : vehicle.kind === 'ego' ? 22 : 10;
    ctx.shadowColor = impactIntensity > 0
      ? `rgba(255, 84, 61, ${0.45 + impactIntensity * 0.45})`
      : vehicle.kind === 'ego'
        ? 'rgba(109, 247, 209, 0.55)'
        : 'rgba(137, 169, 255, 0.20)';
    ctx.fillStyle = vehicle.collision ? '#ff6b6b' : vehicle.color;
    roundedRect(ctx, -width / 2, -length / 2, width, length, Math.min(6, width * 0.22));
    ctx.fill();

    if (impactIntensity > 0) {
      ctx.globalAlpha = impactIntensity * 0.5;
      ctx.fillStyle = '#ff4938';
      roundedRect(ctx, -width / 2, -length / 2, width, length, Math.min(6, width * 0.22));
      ctx.fill();
      ctx.globalAlpha = 0.45 + impactIntensity * 0.5;
      ctx.strokeStyle = '#ffd6c9';
      ctx.lineWidth = 1.2 + impactIntensity * 1.8;
      roundedRect(ctx, -width / 2, -length / 2, width, length, Math.min(6, width * 0.22));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.shadowBlur = 0;
    ctx.fillStyle = vehicle.kind === 'ego' ? '#0c2426' : '#17242a';
    roundedRect(ctx, -width * 0.33, -length * 0.26, width * 0.66, length * 0.28, 3);
    ctx.fill();

    ctx.fillStyle = vehicle.kind === 'ego' ? '#6df7d1' : '#dce8ee';
    ctx.globalAlpha = vehicle.kind === 'ego' ? 0.95 : 0.45;
    ctx.fillRect(-width * 0.24, -length * 0.49, width * 0.48, 2);

    this.drawTurnSignals(vehicle, width, length);
    ctx.restore();
  }

  private vehicleImpactIntensity(snapshot: RenderSnapshot, vehicleId: string): number {
    let intensity = 0;
    for (const event of snapshot.collisionEvents) {
      if (!event.vehicleIds.includes(vehicleId)) continue;
      const progress = clamp01(event.age / event.duration);
      intensity = Math.max(intensity, (1 - progress) ** 1.35);
    }
    return intensity;
  }

  private drawCollisionEffects(snapshot: RenderSnapshot): void {
    const ctx = this.ctx;
    for (const event of snapshot.collisionEvents) {
      const progress = clamp01(event.age / event.duration);
      const fade = (1 - progress) ** 1.45;
      const point = this.worldToScreen(event.point, snapshot);
      const radius = 9 + progress * (34 + event.severity * 20);
      if (point.x < -radius || point.x > this.width + radius || point.y < -radius || point.y > this.height + radius) {
        continue;
      }

      ctx.save();
      ctx.translate(point.x, point.y);

      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 1.15);
      glow.addColorStop(0, `rgba(255, 244, 205, ${fade * 0.75})`);
      glow.addColorStop(0.18, `rgba(255, 112, 61, ${fade * 0.42})`);
      glow.addColorStop(1, 'rgba(255, 49, 34, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.15, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = fade;
      ctx.strokeStyle = '#ff694f';
      ctx.lineWidth = 1.4 + event.severity * 2;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = fade * 0.9;
      ctx.strokeStyle = '#ffe0a6';
      ctx.lineWidth = 1 + event.severity;
      const seed = hashString(event.id);
      for (let index = 0; index < 9; index += 1) {
        const angle = seed * 0.0001 + index * 2.39996;
        const sparkLength = (8 + ((seed >> (index % 12)) & 7)) * (0.7 + event.severity * 0.5);
        const sparkStart = 4 + progress * sparkLength * 0.75;
        const sparkEnd = sparkStart + sparkLength * (1 - progress * 0.45);
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * sparkStart, Math.sin(angle) * sparkStart);
        ctx.lineTo(Math.cos(angle) * sparkEnd, Math.sin(angle) * sparkEnd);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawEgoCollisionFeedback(snapshot: RenderSnapshot): void {
    const event = snapshot.collisionEvents
      .filter((candidate) => candidate.egoInvolved)
      .sort((a, b) => a.age - b.age)[0];
    if (!event) return;

    const ctx = this.ctx;
    const progress = clamp01(event.age / event.duration);
    const fade = (1 - progress) ** 1.7;
    const initialFlash = Math.max(0, 1 - progress / 0.2);
    const edgeRadius = Math.hypot(this.width, this.height) * 0.62;

    ctx.save();
    if (initialFlash > 0) {
      ctx.fillStyle = `rgba(255, 63, 42, ${initialFlash * (0.08 + event.severity * 0.1)})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    const vignette = ctx.createRadialGradient(
      this.width / 2,
      this.height * 0.52,
      edgeRadius * 0.28,
      this.width / 2,
      this.height * 0.52,
      edgeRadius,
    );
    vignette.addColorStop(0, 'rgba(123, 10, 5, 0)');
    vignette.addColorStop(0.58, `rgba(171, 18, 9, ${fade * 0.05})`);
    vignette.addColorStop(1, `rgba(255, 48, 28, ${fade * (0.22 + event.severity * 0.12)})`);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.globalAlpha = fade * 0.9;
    ctx.strokeStyle = '#ff5c43';
    ctx.lineWidth = 2 + event.severity * 2;
    ctx.strokeRect(2, 2, this.width - 4, this.height - 4);

    const label = `EGO IMPACT  /  ${collisionLabel(event.kind)}`;
    ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const labelWidth = Math.ceil(ctx.measureText(label).width) + 30;
    const labelX = (this.width - labelWidth) / 2;
    const labelY = 18;
    ctx.fillStyle = 'rgba(35, 7, 5, 0.9)';
    ctx.strokeStyle = 'rgba(255, 108, 77, 0.9)';
    ctx.lineWidth = 1;
    roundedRect(ctx, labelX, labelY, labelWidth, 30, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffd8c8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, this.width / 2, labelY + 15);
    ctx.restore();
  }

  private drawTurnSignals(vehicle: RenderVehicle, width: number, length: number): void {
    const direction = Math.sign(vehicle.targetLane - vehicle.laneIndex);
    if (direction === 0) return;

    // Keep the indicators blinking even when the simulation is paused.
    const isLit = Math.floor(performance.now() / 420) % 2 === 0;
    if (!isLit) return;

    const ctx = this.ctx;
    const sideX = direction < 0 ? -width / 2 : width / 2;
    const insetX = direction < 0 ? 1.4 : -1.4;
    const signalWidth = Math.max(3.5, width * 0.18);
    const signalHeight = Math.max(3, length * 0.055);

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffb629';
    ctx.shadowColor = '#ff9d00';
    ctx.shadowBlur = vehicle.kind === 'ego' ? 14 : 10;

    for (const y of [-length * 0.38, length * 0.38]) {
      roundedRect(
        ctx,
        sideX + insetX - signalWidth / 2,
        y - signalHeight / 2,
        signalWidth,
        signalHeight,
        signalHeight / 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  private drawLaneSamples(snapshot: RenderSnapshot, scale: number): void {
    if (!snapshot.settings.debugOverlays) return;
    const ctx = this.ctx;
    const drawSet = (samples: LaneLineSample[], color: string) => {
      for (const sample of samples) {
        const screen = this.relativeToScreen(sample.x, sample.y);
        ctx.save();
        ctx.globalAlpha = 0.25 + sample.confidence * 0.55;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, Math.max(2, scale * 0.23), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    drawSet(snapshot.sensors.laneLines.left, '#6df7d1');
    drawSet(snapshot.sensors.laneLines.right, '#6df7d1');
    drawSet(snapshot.sensors.laneLines.farLeft, '#89a9ff');
    drawSet(snapshot.sensors.laneLines.farRight, '#89a9ff');
  }

  private drawDetections(snapshot: RenderSnapshot, scale: number): void {
    if (!snapshot.settings.debugOverlays) return;
    for (const measurement of snapshot.sensors.measurements) this.drawMeasurement(measurement, scale);
    for (const track of snapshot.sensors.tracks) this.drawTrack(track, scale);
  }

  private drawMeasurement(measurement: VehicleMeasurement, scale: number): void {
    const ctx = this.ctx;
    const center = this.relativeToScreen(measurement.relativeX, measurement.relativeY);
    const width = measurement.width * scale;
    const length = measurement.length * scale;

    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(measurement.relativeHeading);
    ctx.globalAlpha = 0.2 + measurement.confidence * 0.45;
    ctx.strokeStyle = '#f7c86d';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(-width / 2, -length / 2, width, length);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(247, 200, 109, 0.07)';
    ctx.fillRect(-width / 2, -length / 2, width, length);

    ctx.fillStyle = '#f7c86d';
    ctx.beginPath();
    ctx.arc(0, -length / 2 - 3, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawTrack(track: VehicleTrack, scale: number): void {
    const ctx = this.ctx;
    const center = this.relativeToScreen(track.relativeX, track.relativeY);
    const width = track.width * scale;
    const length = track.length * scale;
    const predictedFade = track.isPredicted
      ? Math.max(0.28, 1 - track.timeSinceMeasurement / 0.52)
      : 1;

    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.globalAlpha = predictedFade * (0.35 + track.confidence * 0.55);
    ctx.strokeStyle = '#6df7d1';
    ctx.lineWidth = 1;
    ctx.setLineDash(track.isPredicted ? [2, 4] : []);
    ctx.beginPath();
    ctx.ellipse(
      0,
      0,
      Math.max(2, track.uncertainty.lateralPosition * scale * 2),
      Math.max(3, track.uncertainty.longitudinalPosition * scale * 2),
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(track.relativeHeading);
    ctx.globalAlpha = predictedFade * (0.35 + track.confidence * 0.6);
    ctx.strokeStyle = '#6df7d1';
    ctx.lineWidth = 1.7;
    ctx.setLineDash(track.isPredicted ? [3, 3] : []);
    ctx.strokeRect(-width / 2, -length / 2, width, length);
    ctx.setLineDash([]);
    ctx.fillStyle = track.isPredicted ? 'rgba(109, 247, 209, 0.04)' : 'rgba(109, 247, 209, 0.09)';
    ctx.fillRect(-width / 2, -length / 2, width, length);

    // A nose marker keeps the filtered yaw readable independently of the raw box.
    ctx.fillStyle = '#6df7d1';
    ctx.beginPath();
    ctx.moveTo(0, -length / 2 - 5);
    ctx.lineTo(-Math.min(5, width * 0.22), -length / 2 + 2);
    ctx.lineTo(Math.min(5, width * 0.22), -length / 2 + 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawPerceptionLegend(snapshot: RenderSnapshot): void {
    if (!snapshot.settings.debugOverlays) return;
    const ctx = this.ctx;
    const width = 156;
    const height = 58;
    const x = this.width - width - 14;
    const y = this.height - height - 14;

    ctx.save();
    ctx.fillStyle = 'rgba(5, 15, 18, 0.82)';
    ctx.strokeStyle = 'rgba(109, 247, 209, 0.18)';
    ctx.lineWidth = 1;
    roundedRect(ctx, x, y, width, height, 7);
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';

    ctx.strokeStyle = '#f7c86d';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 10, y + 11, 15, 8);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(247, 200, 109, 0.9)';
    ctx.fillText('RAW MEASUREMENT', x + 34, y + 15);

    ctx.strokeStyle = '#6df7d1';
    ctx.strokeRect(x + 10, y + 29, 15, 8);
    ctx.fillStyle = 'rgba(109, 247, 209, 0.94)';
    ctx.fillText('TRACK', x + 34, y + 33);

    ctx.strokeStyle = 'rgba(109, 247, 209, 0.72)';
    ctx.setLineDash([2, 3]);
    ctx.strokeRect(x + 10, y + 45, 15, 7);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(109, 247, 209, 0.72)';
    ctx.fillText('PREDICTED', x + 34, y + 49);
    ctx.restore();
  }

  private drawControlOverlay(snapshot: RenderSnapshot): void {
    const ctx = this.ctx;
    const x = 18;
    const y = this.height - 82;
    const width = 142;
    const telemetry = snapshot.telemetry;

    ctx.save();
    ctx.fillStyle = 'rgba(5, 12, 14, 0.72)';
    ctx.strokeStyle = 'rgba(109, 247, 209, 0.18)';
    ctx.lineWidth = 1;
    roundedRect(ctx, x, y, width, 62, 8);
    ctx.fill();
    ctx.stroke();

    this.drawMiniBar(x + 14, y + 18, width - 28, telemetry.finalMotor, telemetry.actualMotor, '#6df7d1', 'MOTOR');
    this.drawMiniBar(x + 14, y + 44, width - 28, telemetry.finalSteering, telemetry.actualSteering, '#89a9ff', 'STEER');
    ctx.restore();
  }

  private drawMiniBar(x: number, y: number, width: number, command: number, actual: number, color: string, label: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(230, 247, 244, 0.68)';
    ctx.fillText(label, x, y - 6);
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fillRect(x, y, width, 5);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.fillRect(x + width / 2, y, (command * width) / 2, 5);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    const actualX = x + width / 2 + (actual * width) / 2;
    ctx.moveTo(actualX, y - 3);
    ctx.lineTo(actualX, y + 8);
    ctx.stroke();
    ctx.restore();
  }

  private worldToScreen(point: RenderPoint, snapshot: RenderSnapshot): ScreenPoint {
    const dx = point.x - snapshot.camera.x;
    const dy = point.y - snapshot.camera.y;
    const heading = snapshot.camera.heading;
    const forward = { x: Math.sin(heading), y: Math.cos(heading) };
    const right = { x: Math.cos(heading), y: -Math.sin(heading) };
    const localX = dx * right.x + dy * right.y;
    const localY = dx * forward.x + dy * forward.y;
    return this.relativeToScreen(localX, localY);
  }

  private relativeToScreen(relativeX: number, relativeY: number): ScreenPoint {
    return {
      x: this.width / 2 + relativeX * this.scale,
      y: this.height * 0.72 - relativeY * this.scale,
    };
  }
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function collisionLabel(kind: CollisionKind): string {
  if (kind === 'rear-end') return 'REAR IMPACT';
  if (kind === 'sideswipe') return 'SIDESWIPE';
  return 'CORNER CONTACT';
}
