import type { LaneLineSample, VehicleDetection } from '../types';
import type { RenderPoint, RenderSnapshot, RenderVehicle } from './types';

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
    this.drawControlOverlay(snapshot);
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

    const north = this.worldToScreen({ x: snapshot.camera.x, y: snapshot.camera.y + 18 }, snapshot);
    const origin = this.relativeToScreen(0, 0);
    ctx.strokeStyle = 'rgba(247, 200, 109, 0.45)';
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(north.x, north.y);
    ctx.stroke();
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

    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(relativeHeading);

    ctx.shadowBlur = vehicle.kind === 'ego' ? 22 : 10;
    ctx.shadowColor = vehicle.kind === 'ego' ? 'rgba(109, 247, 209, 0.55)' : 'rgba(137, 169, 255, 0.20)';
    ctx.fillStyle = vehicle.collision ? '#ff6b6b' : vehicle.color;
    roundedRect(ctx, -width / 2, -length / 2, width, length, Math.min(6, width * 0.22));
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = vehicle.kind === 'ego' ? '#0c2426' : '#17242a';
    roundedRect(ctx, -width * 0.33, -length * 0.26, width * 0.66, length * 0.28, 3);
    ctx.fill();

    ctx.fillStyle = vehicle.kind === 'ego' ? '#6df7d1' : '#dce8ee';
    ctx.globalAlpha = vehicle.kind === 'ego' ? 0.95 : 0.45;
    ctx.fillRect(-width * 0.24, -length * 0.49, width * 0.48, 2);
    ctx.restore();

    if (vehicle.kind === 'ego') {
      this.drawSteeringVector(screen, snapshot.telemetry.actualSteering);
    }
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
    const ctx = this.ctx;
    for (const detection of snapshot.sensors.detections) {
      this.drawDetection(detection, scale);
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(109, 247, 209, 0.11)';
    ctx.lineWidth = 1;
    const origin = this.relativeToScreen(0, 0);
    for (const distance of [24, 48, 72, 96]) {
      ctx.beginPath();
      ctx.ellipse(origin.x, origin.y, distance * scale * 0.55, distance * scale, 0, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDetection(detection: VehicleDetection, scale: number): void {
    const ctx = this.ctx;
    const center = this.relativeToScreen(detection.relativeX, detection.relativeY);
    const width = detection.width * scale;
    const length = detection.length * scale;

    ctx.save();
    ctx.globalAlpha = 0.25 + detection.confidence * 0.55;
    ctx.strokeStyle = '#f7c86d';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(center.x - width / 2, center.y - length / 2, width, length);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(247, 200, 109, 0.12)';
    ctx.fillRect(center.x - width / 2, center.y - length / 2, width, length);
    ctx.restore();
  }

  private drawSteeringVector(origin: ScreenPoint, steering: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.strokeStyle = '#6df7d1';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(109, 247, 209, 0.45)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.quadraticCurveTo(steering * 36, -38, steering * 52, -56);
    ctx.stroke();
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
