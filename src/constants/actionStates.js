

const damageStates = [0x4B,0x4C,0x4D,0x4E,0x4F,0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x57,0x58,0x59,0x5A,0x5B]
const shineStates = [360,361,362,363,364,365,366,367,368]

const actionStates = [
    {
      id: 1,
      name: "Damage",
      shortName: "Damage",
      actionStateID: damageStates
    },
    {
      id: 35,
      name: "Special Fall",
      shortName: "Special Fall",
      actionStateID: [35,36,37]
    },
    {
      id: 58,
      name: "Smash Attack",
      shortName: "Smash Attack",
      actionStateID: [58,59,60,61,62,63,64]
    },
    {
      id: 100,
      name: "Shield Stun",
      shortName: "Shield Stun",
      actionStateID: 0xB5
    },
    {
      id: 101,
      name: "Shine",
      shortName: "Shine",
      actionStateID: shineStates
    },
    {
      id: 102,
      name: "Rest",
      shortName: "Rest",
      actionStateID: [369,370,371,372]
    },
    {
      id: 103,
      name: "Star KO",
      shortName: "Star KO",
      actionStateID: [4]
    },
    {
      id: 104,
      name: "Plat Drop",
      shortName: "Plat Drop",
      actionStateID: [0xF4]
    },
    {
      id: 105,
      name: "Double Jump",
      shortName: "Double Jump",
      actionStateID: [0x1B,0x1C]
    },
    {
      id: 185,
      name: "Missed tech damage",
      shortName: "Missed tech damage",
      actionStateID: [185,193]
    },
    {
      id: 188,
      name: "Any Roll",
      shortName: "Any Roll",
      actionStateID: [188,189,196,197,200,201,233,234,258,259]
    },
    {
      id: 189,
      name: "Missed Tech Roll",
      shortName: "Missed Tech Roll",
      actionStateID: [188,189,196,197]
    },
    {
      id: 199,
      name: "Neutral Tech",
      shortName: "Neutral Tech",
      actionStateID: [199]
    },
    {
      id: 200,
      name: "Tech Roll",
      shortName: "Tech Roll",
      actionStateID: [200,201]
    },
    {
      id: 202,
      name: "Wall tech",
      shortName: "Wall tech",
      actionStateID: [202]
    },
    {
      id: 203,
      name: "Wall jump",
      shortName: "Wall jump",
      actionStateID: [203]
    }, 
    {
      id: 212,
      name: "Grab",
      shortName: "Grab",
      actionStateID: [212]
    },
    {
      id: 233,
      name: "Normal Roll",
      shortName: "Normal Roll",
      actionStateID: [233,234]
    },
    {
      id: 235,
      name: "Spot Dodge",
      shortName: "Spot Dodge",
      actionStateID: [235]
    },
    {
      id: 236,
      name: "Air Dodge",
      shortName: "Air Dodge",
      actionStateID: [236]
    },
    {
      id: 258,
      name: "Ledge Roll",
      shortName: "Ledge Roll",
      actionStateID: [258,259]
    },
    {
      id: 297,
      name: "Asleep",
      shortName: "Asleep",
      actionStateID: [297,298,299]
    },
    {
      id: 345,
      name: "Doc Side B",
      shortName: "Doc Side B",
      actionStateID: [345,346]
    },
    {
      id: 347,
      name: "Spacie Side B",
      shortName: "Spacie Side B",
      actionStateID: [347,348,349,350,351,352]
    },
    {
      id: 354,
      name: "Spacie Up B",
      shortName: "Spacie Up B",
      actionStateID: [354,356]
    },
    {
      id: 360,
      name: "Sheik Poof Reappear",
      shortName: "Sheik Poof Reappear",
      actionStateID: [360]
    },
    {
      id: 2,
      name: "Jab",
      shortName: "jab",
      actionStateID: 0x2c
    },
    {
      id: 3,
      name: "Jab",
      shortName: "jab",
      actionStateID: 0x2d
    },
    {
      id: 4,
      name: "Jab",
      shortName: "jab",
      actionStateID: 0x2e
    },
    {
      id: 5,
      name: "Rapid Jabs",
      shortName: "rapid-jabs",
      actionStateID: 0x2f
    },
    {
      id: 6,
      name: "Dash Attack",
      shortName: "dash",
      actionStateID: 0x32
    },
    {
      id: 8,
      name: "Up Tilt",
      shortName: "utilt",
      actionStateID: 0x38
    },
    {
      id: 9,
      name: "Down Tilt",
      shortName: "dtilt",
      actionStateID: 0x39
    },
    {
      id: 11,
      name: "Up Smash",
      shortName: "usmash",
      actionStateID: 0x3f
    },
    {
      id: 12,
      name: "Down Smash",
      shortName: "dsmash",
      actionStateID: 0x40
    },
    {
      id: 13,
      name: "Neutral Air",
      shortName: "nair",
      actionStateID: 0x41
    },
    {
      id: 14,
      name: "Forward Air",
      shortName: "fair",
      actionStateID: 0x42
    },
    {
      id: 15,
      name: "Back Air",
      shortName: "bair",
      actionStateID: 0x43
    },
    {
      id: 16,
      name: "Up Air",
      shortName: "uair",
      actionStateID: 0x44
    },
    {
      id: 17,
      name: "Down Air",
      shortName: "dair",
      actionStateID: 0x45
    },
  ];
  
  module.exports = {actionStates}