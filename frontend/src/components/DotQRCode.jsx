import React from "react";

// Pre-generated QR matrix for https://gossipsss.netlify.app/ (version 2, 25x25, ECC Low)
const QR_MATRIX = [
  [1,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,0,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,1,0,1,0,0,1,0,1,1,1,0,0,1,0,0,0,0,0,1],
  [1,0,1,1,1,0,1,0,1,0,0,1,1,0,0,1,1,0,1,0,1,1,1,0,1],
  [1,0,1,1,1,0,1,0,0,1,0,1,1,0,1,1,1,0,1,0,1,1,1,0,1],
  [1,0,1,1,1,0,1,0,1,1,0,1,0,0,1,1,1,0,1,0,1,1,1,0,1],
  [1,0,0,0,0,0,1,0,1,0,1,0,0,0,0,1,1,0,1,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,0,1,0,1,0,1,0,1,0,1,0,1,1,1,1,1,1,1],
  [0,0,0,0,0,0,0,0,1,0,1,1,0,0,0,0,1,0,0,0,0,0,0,0,0],
  [1,1,0,1,0,0,1,1,0,0,0,1,0,1,1,0,0,0,1,1,1,0,1,1,0],
  [0,1,1,0,1,0,0,0,1,1,0,0,1,1,0,0,1,1,1,0,0,0,0,0,1],
  [0,1,0,1,1,1,1,0,1,0,0,0,0,1,0,0,1,1,0,0,0,0,0,1,1],
  [1,1,0,0,0,1,0,0,0,1,1,0,0,1,0,0,0,1,1,0,1,0,0,0,0],
  [1,0,0,1,1,0,1,1,1,0,1,0,1,1,0,0,0,1,1,0,0,1,0,1,1],
  [0,1,0,0,1,1,0,1,1,1,0,0,1,0,1,0,0,0,1,1,0,1,1,0,1],
  [1,0,0,0,1,1,1,1,0,1,0,1,1,0,1,0,1,1,1,1,1,0,1,0,1],
  [0,1,0,1,0,1,0,1,0,1,1,0,1,1,0,1,0,0,1,0,1,0,0,1,0],
  [1,1,0,0,0,1,1,0,1,0,1,1,1,0,0,0,1,1,1,1,1,1,1,0,0],
  [0,0,0,0,0,0,0,0,1,0,0,1,0,0,1,0,1,0,0,0,1,1,0,0,1],
  [1,1,1,1,1,1,1,0,1,0,1,0,0,0,0,1,1,0,1,0,1,1,0,1,1],
  [1,0,0,0,0,0,1,0,0,1,1,1,0,0,0,0,1,0,0,0,1,1,1,1,1],
  [1,0,1,1,1,0,1,0,0,1,1,0,0,1,1,0,1,1,1,1,1,1,0,0,0],
  [1,0,1,1,1,0,1,0,1,0,0,0,1,0,0,0,0,0,0,1,1,1,1,0,0],
  [1,0,1,1,1,0,1,0,0,1,1,0,1,1,1,0,1,1,0,1,1,0,1,0,1],
  [1,0,0,0,0,0,1,0,1,0,0,1,1,1,0,1,1,0,0,0,0,1,0,0,0],
  [1,1,1,1,1,1,1,0,1,0,0,0,1,1,0,1,1,1,0,1,0,0,0,1,1],
];

const SIZE = 25;
const VBOX = 1024;
const MARGIN = 62;
const CELL = (VBOX - 2 * MARGIN) / SIZE; // 36
const R = CELL * 0.444; // ~16, slightly less than half-cell

function isFinderArea(row, col) {
  if (row <= 6 && col <= 6) return true;           // top-left
  if (row <= 6 && col >= SIZE - 7) return true;    // top-right
  if (row >= SIZE - 7 && col <= 6) return true;    // bottom-left
  return false;
}

// Rounded-square ring path using fill-rule="evenodd"
function finderRingPath(ox, oy) {
  const fs = 7 * CELL;                     // 252 — outer square side
  const rx = Math.round(fs * 0.357);       // 90 — outer corner radius
  const io = CELL;                          // 36 — inner offset (1 module)
  const is = 5 * CELL;                     // 180 — inner square side
  const ir = Math.round(is * 0.30);        // 54 — inner corner radius

  const o = (x, y, w, h, r) =>
    `M ${x} ${y + r} v ${h - 2*r} a ${r} ${r} 0 0 0 ${r} ${r} h ${w - 2*r} a ${r} ${r} 0 0 0 ${r} ${-r} v ${-(h - 2*r)} a ${r} ${r} 0 0 0 ${-r} ${-r} h ${-(w - 2*r)} a ${r} ${r} 0 0 0 ${-r} ${r} Z`;

  return `${o(ox, oy, fs, fs, rx)} ${o(ox + io, oy + io, is, is, ir)}`;
}

// Rounded square for the 3×3 inner dot
function finderDotPath(ox, oy) {
  const ds = 3 * CELL;                     // 108
  const dx = ox + 2 * CELL;
  const dy = oy + 2 * CELL;
  const dr = Math.round(ds * 0.296);       // 32

  return `M ${dx} ${dy + dr} v ${ds - 2*dr} a ${dr} ${dr} 0 0 0 ${dr} ${dr} h ${ds - 2*dr} a ${dr} ${dr} 0 0 0 ${dr} ${-dr} v ${-(ds - 2*dr)} a ${dr} ${dr} 0 0 0 ${-dr} ${-dr} h ${-(ds - 2*dr)} a ${dr} ${dr} 0 0 0 ${-dr} ${dr} Z`;
}

export default function DotQRCode({ className }) {
  const finderCorners = [
    [MARGIN, MARGIN],                            // top-left
    [MARGIN + (SIZE - 7) * CELL, MARGIN],        // top-right
    [MARGIN, MARGIN + (SIZE - 7) * CELL],        // bottom-left
  ];

  const dots = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (QR_MATRIX[row][col] && !isFinderArea(row, col)) {
        const cx = MARGIN + col * CELL + CELL / 2;
        const cy = MARGIN + row * CELL + CELL / 2;
        dots.push(<circle key={`${row}-${col}`} cx={cx} cy={cy} r={R} fill="white" />);
      }
    }
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VBOX} ${VBOX}`}
      className={className}
    >
      {dots}
      {finderCorners.map(([x, y], i) => (
        <React.Fragment key={i}>
          <path d={finderRingPath(x, y)} fill="white" fillRule="evenodd" />
          <path d={finderDotPath(x, y)} fill="white" />
        </React.Fragment>
      ))}
    </svg>
  );
}
