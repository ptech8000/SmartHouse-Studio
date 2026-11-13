import React, { useRef, useEffect } from 'react';

interface SensorWaveformProps {
  acc: { x: number; y: number; z: number };
  isSimulating: boolean;
  wristTapActive?: boolean;
}

export const SensorWaveform: React.FC<SensorWaveformProps> = ({
  acc,
  isSimulating,
  wristTapActive
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<{ x: number; y: number; z: number }[]>([]);

  useEffect(() => {
    const history = historyRef.current;
    history.push({ ...acc });
    if (history.length > 80) {
      history.shift();
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear background
    ctx.fillStyle = wristTapActive ? '#451a03' : '#090d16';
    ctx.fillRect(0, 0, width, height);

    // Subtle grid lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.moveTo(0, height / 4);
    ctx.lineTo(width, height / 4);
    ctx.moveTo(0, (height * 3) / 4);
    ctx.lineTo(width, (height * 3) / 4);
    ctx.stroke();

    if (!isSimulating || history.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.font = '10px monospace';
      ctx.fillText('STANDBY — NO LIVE STREAM', width / 2 - 65, height / 2 + 3);
      return;
    }

    // Draw X channel (Cyan)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    history.forEach((pt, idx) => {
      const cx = (idx / 80) * width;
      // Normalize mG to canvas height: 0mG at height/2, range +- 2000mG
      const cy = height / 2 - (pt.x / 1800) * (height / 2.2);
      if (idx === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();

    // Draw Y channel (Amber)
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    history.forEach((pt, idx) => {
      const cx = (idx / 80) * width;
      const cy = height / 2 - (pt.y / 1800) * (height / 2.2);
      if (idx === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();

    // Draw Z channel (Emerald)
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    history.forEach((pt, idx) => {
      const cx = (idx / 80) * width;
      // Z sits around +980mG
      const cy = height / 2 - ((pt.z - 980) / 1800) * (height / 2.2);
      if (idx === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();

    // Channel legend watermark
    ctx.font = '9px monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText('X', width - 36, 12);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('Y', width - 24, 12);
    ctx.fillStyle = '#34d399';
    ctx.fillText('Z', width - 12, 12);
  }, [acc, isSimulating, wristTapActive]);

  return (
    <div className="sensor-waveform-container">
      <canvas
        ref={canvasRef}
        width={300}
        height={64}
        className="sensor-waveform-canvas"
      />
    </div>
  );
};
