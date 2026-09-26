'use strict';

// Grand Exchange convenience fee (the "tax"): 2% of the sale price per item,
// rounded down, capped at 5,000,000 gp per item. The rounding means anything
// sold for under 50 gp pays nothing. A few items (bonds, basic tools, some
// teleport tablets) are fully exempt.
const TAX_RATE = 0.02;
const TAX_CAP = 5_000_000;

const EXEMPT = new Set([
  'old school bond',
  'chisel', 'gardening trowel', 'glassblowing pipe', 'hammer', 'needle',
  'pestle and mortar', 'rake', 'saw', 'secateurs', 'seed dibber', 'shears',
  'spade', 'watering can(0)',
  'ardougne teleport (tablet)', 'camelot teleport (tablet)', 'civitas illa fortis teleport (tablet)',
  'falador teleport (tablet)', 'kourend castle teleport (tablet)', 'lumbridge teleport (tablet)',
  'teleport to house (tablet)', 'varrock teleport (tablet)',
]);

function taxPerItem(price, itemName) {
  if (itemName && EXEMPT.has(itemName.toLowerCase())) return 0;
  return Math.min(Math.floor(price * TAX_RATE), TAX_CAP);
}

function netSale(price, itemName) {
  return price - taxPerItem(price, itemName);
}

module.exports = { TAX_RATE, TAX_CAP, taxPerItem, netSale };
