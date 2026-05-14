// 24 spectral steps from 400nm to 685nm, with dense sampling around the
// hemoglobin absorption window (520-580nm) where skin has the most distinctive
// spectral signature. Near-IR steps (700-745nm) were removed — phone screens
// emit <5% luminance there, giving negligible signal after ambient correction.
// RGB values are linearly interpolated approximations of each wavelength band.

const SPECTRAL_COLORS = [
  { nm: 400, hex: '#7B00D4', rgb: [123,   0, 212], name: 'Violet'       },
  { nm: 415, hex: '#5500FF', rgb: [ 85,   0, 255], name: 'Blue-Violet'  },
  { nm: 430, hex: '#2200FF', rgb: [ 34,   0, 255], name: 'Deep Blue'    },
  { nm: 445, hex: '#001AFF', rgb: [  0,  26, 255], name: 'Royal Blue'   },
  { nm: 460, hex: '#0055FF', rgb: [  0,  85, 255], name: 'Blue'         },
  { nm: 475, hex: '#0088FF', rgb: [  0, 136, 255], name: 'Cerulean'     },
  { nm: 490, hex: '#00BBFF', rgb: [  0, 187, 255], name: 'Sky Cyan'     },
  { nm: 505, hex: '#00FFD9', rgb: [  0, 255, 217], name: 'Cyan'         },
  { nm: 520, hex: '#00FF88', rgb: [  0, 255, 136], name: 'Seafoam'      }, // ─┐
  { nm: 527, hex: '#00FF55', rgb: [  0, 255,  85], name: 'Pure Green'   }, //  │ dense
  { nm: 535, hex: '#00FF22', rgb: [  0, 255,  34], name: 'Green'        }, //  │ hemoglobin
  { nm: 542, hex: '#33FF00', rgb: [ 51, 255,   0], name: 'Chartreuse'   }, //  │ absorption
  { nm: 550, hex: '#77FF00', rgb: [119, 255,   0], name: 'Lime'         }, //  │ window
  { nm: 557, hex: '#99FF00', rgb: [153, 255,   0], name: 'Yellow-Lime'  }, //  │ (535-565nm)
  { nm: 565, hex: '#BBFF00', rgb: [187, 255,   0], name: 'Yellow-Green' }, //  │
  { nm: 572, hex: '#DDFF00', rgb: [221, 255,   0], name: 'Warm Lime'    }, // ─┘
  { nm: 580, hex: '#FFFF00', rgb: [255, 255,   0], name: 'Yellow'       },
  { nm: 595, hex: '#FFCC00', rgb: [255, 204,   0], name: 'Amber'        },
  { nm: 610, hex: '#FF8800', rgb: [255, 136,   0], name: 'Orange'       },
  { nm: 625, hex: '#FF4400', rgb: [255,  68,   0], name: 'Red-Orange'   },
  { nm: 640, hex: '#FF1100', rgb: [255,  17,   0], name: 'Scarlet'      },
  { nm: 655, hex: '#FF0000', rgb: [255,   0,   0], name: 'Red'          },
  { nm: 670, hex: '#DD0000', rgb: [221,   0,   0], name: 'Deep Red'     },
  { nm: 685, hex: '#BB0000', rgb: [187,   0,   0], name: 'Dark Red'     },
];

// 12 key steps for fast verification — every other step from SPECTRAL_COLORS.
// The even-index selection now includes 535nm and 565nm (indices 10 and 14),
// so all five hemoglobin wavelengths (520/535/550/565/580nm) are present in
// both registration and verification scans.
const VERIFY_COLORS = SPECTRAL_COLORS.filter((_, i) => i % 2 === 0);
