// 24 spectral steps evenly distributed from 400nm to 745nm (~15nm apart)
// Used for registration — full spectrum for maximum template quality.
// RGB values are approximate screen-reproducible colors for each wavelength band.
// Screens can't emit monochromatic light, but each step produces a distinct
// illumination spectrum — the relative skin reflectance under each is what matters.

const SPECTRAL_COLORS = [
  { nm: 400, hex: '#7B00D4', rgb: [123,   0, 212], name: 'Violet'       },
  { nm: 415, hex: '#5500FF', rgb: [ 85,   0, 255], name: 'Blue-Violet'  },
  { nm: 430, hex: '#2200FF', rgb: [ 34,   0, 255], name: 'Deep Blue'    },
  { nm: 445, hex: '#001AFF', rgb: [  0,  26, 255], name: 'Royal Blue'   },
  { nm: 460, hex: '#0055FF', rgb: [  0,  85, 255], name: 'Blue'         },
  { nm: 475, hex: '#0088FF', rgb: [  0, 136, 255], name: 'Cerulean'     },
  { nm: 490, hex: '#00BBFF', rgb: [  0, 187, 255], name: 'Sky Cyan'     },
  { nm: 505, hex: '#00FFD9', rgb: [  0, 255, 217], name: 'Cyan'         },
  { nm: 520, hex: '#00FF88', rgb: [  0, 255, 136], name: 'Seafoam'      },
  { nm: 535, hex: '#00FF22', rgb: [  0, 255,  34], name: 'Green'        },
  { nm: 550, hex: '#77FF00', rgb: [119, 255,   0], name: 'Lime'         },
  { nm: 565, hex: '#BBFF00', rgb: [187, 255,   0], name: 'Yellow-Green' },
  { nm: 580, hex: '#FFFF00', rgb: [255, 255,   0], name: 'Yellow'       },
  { nm: 595, hex: '#FFCC00', rgb: [255, 204,   0], name: 'Amber'        },
  { nm: 610, hex: '#FF8800', rgb: [255, 136,   0], name: 'Orange'       },
  { nm: 625, hex: '#FF4400', rgb: [255,  68,   0], name: 'Red-Orange'   },
  { nm: 640, hex: '#FF1100', rgb: [255,  17,   0], name: 'Scarlet'      },
  { nm: 655, hex: '#FF0000', rgb: [255,   0,   0], name: 'Red'          },
  { nm: 670, hex: '#DD0000', rgb: [221,   0,   0], name: 'Deep Red'     },
  { nm: 685, hex: '#BB0000', rgb: [187,   0,   0], name: 'Dark Red'     },
  { nm: 700, hex: '#990000', rgb: [153,   0,   0], name: 'Near-IR 1'    },
  { nm: 715, hex: '#770000', rgb: [119,   0,   0], name: 'Near-IR 2'    },
  { nm: 730, hex: '#550000', rgb: [ 85,   0,   0], name: 'Near-IR 3'    },
  { nm: 745, hex: '#330000', rgb: [ 51,   0,   0], name: 'Near-IR 4'    },
];

// 12 key steps for fast verification — every other step from SPECTRAL_COLORS.
// Covers all critical zones (blue absorption, hemoglobin dip, red peak, near-IR)
// at half the count for ~3-4 second scans.
const VERIFY_COLORS = SPECTRAL_COLORS.filter((_, i) => i % 2 === 0);
