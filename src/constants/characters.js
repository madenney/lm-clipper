const characters = [{
  id: 0,
  name: "Captain Falcon",
  shortName: "Falcon",
  colors: ["Default", "Black", "Red", "Pink", "Green", "Blue"],
  img: "character-icons/falcon/"
}, {
  id: 1,
  name: "Donkey Kong",
  shortName: "DK",
  colors: ["Default", "Black", "Red", "Blue", "Green"],
  img: "character-icons/dk/"
}, {
  id: 2,
  name: "Fox",
  shortName: "Fox",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/fox/"
}, {
  id: 3,
  name: "Mr. Game & Watch",
  shortName: "G&W",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/gnw/"
}, {
  id: 4,
  name: "Kirby",
  shortName: "Kirby",
  colors: ["Default", "Yellow", "Blue", "Red", "Green", "White"],
  img: "character-icons/kirby/"
}, {
  id: 5,
  name: "Bowser",
  shortName: "Bowser",
  colors: ["Default", "Red", "Blue", "Black"],
  img: "character-icons/bowser/"
}, {
  id: 6,
  name: "Link",
  shortName: "Link",
  colors: ["Default", "Red", "Blue", "Black", "White"],
  img: "character-icons/link/"
}, {
  id: 7,
  name: "Luigi",
  shortName: "Luigi",
  colors: ["Default", "White", "Blue", "Pink"],
  img: "character-icons/luigi/"
}, {
  id: 8,
  name: "Mario",
  shortName: "Mario",
  colors: ["Default", "Yellow", "Black", "Blue", "Green"],
  img: "character-icons/mario/"
}, {
  id: 9,
  name: "Marth",
  shortName: "Marth",
  colors: ["Default", "Red", "Green", "Black", "White"],
  img: "character-icons/marth/"
}, {
  id: 10,
  name: "Mewtwo",
  shortName: "Mewtwo",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/mewtwo/"
}, {
  id: 11,
  name: "Ness",
  shortName: "Ness",
  colors: ["Default", "Yellow", "Blue", "Green"],
  img: "character-icons/ness/"
}, {
  id: 12,
  name: "Peach",
  shortName: "Peach",
  colors: ["Default", "Daisy", "White", "Blue", "Green"],
  img: "character-icons/peach/"
}, {
  id: 13,
  name: "Pikachu",
  shortName: "Pikachu",
  colors: ["Default", "Red", "Party_Hat", "Fedora"],
  img: "character-icons/pikachu/"
}, {
  id: 14,
  name: "Ice Climbers",
  shortName: "ICs",
  colors: ["Default", "Green", "Orange", "Red"],
  img: "character-icons/ics/"
}, {
  id: 15,
  name: "Jigglypuff",
  shortName: "Puff",
  colors: ["Default", "Flower", "Bow", "Headband", "Crown"],
  img: "character-icons/puff/"
}, {
  id: 16,
  name: "Samus",
  shortName: "Samus",
  colors: ["Default", "Pink", "Black", "Green", "Purple"],
  img: "character-icons/samus/"
}, {
  id: 17,
  name: "Yoshi",
  shortName: "Yoshi",
  colors: ["Default", "Red", "Blue", "Yellow", "Pink", "Cyan"],
  img: "character-icons/yoshi/"
}, {
  id: 18,
  name: "Zelda",
  shortName: "Zelda",
  colors: ["Default", "Red", "Blue", "Green", "White"],
  img: "character-icons/zelda/"
}, {
  id: 19,
  name: "Sheik",
  shortName: "Sheik",
  colors: ["Default", "Red", "Blue", "Green", "White"],
  img: "character-icons/sheik/"
}, {
  id: 20,
  name: "Falco",
  shortName: "Falco",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/falco/"
}, {
  id: 21,
  name: "Young Link",
  shortName: "YLink",
  colors: ["Default", "Red", "Blue", "White", "Black"],
  img: "character-icons/yl/"
}, {
  id: 22,
  name: "Dr. Mario",
  shortName: "Doc",
  colors: ["Default", "Red", "Blue", "Green", "Black"],
  img: "character-icons/doc/"
}, {
  id: 23,
  name: "Roy",
  shortName: "Roy",
  colors: ["Default", "Red", "Blue", "Green", "Yellow"],
  img: "character-icons/roy/"
}, {
  id: 24,
  name: "Pichu",
  shortName: "Pichu",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/pichu/"
}, {
  id: 25,
  name: "Ganondorf",
  shortName: "Ganon",
  colors: ["Default", "Red", "Blue", "Green", "Purple"],
  img: "character-icons/ganon/"
}];

const sortedCharacters = [{
  id: 2,
  name: "Fox",
  shortName: "Fox",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/fox/"
}, {
  id: 20,
  name: "Falco",
  shortName: "Falco",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/falco/"
}, {
  id: 9,
  name: "Marth",
  shortName: "Marth",
  colors: ["Default", "Red", "Green", "Black", "White"],
  img: "character-icons/marth/"
}, {
  id: 19,
  name: "Sheik",
  shortName: "Sheik",
  colors: ["Default", "Red", "Blue", "Green", "White"],
  img: "character-icons/sheik/"
},{
  id: 15,
  name: "Jigglypuff",
  shortName: "Puff",
  colors: ["Default", "Flower", "Bow", "Headband", "Crown"],
  img: "character-icons/puff/"
},{
  id: 0,
  name: "Captain Falcon",
  shortName: "Falcon",
  colors: ["Default", "Black", "Red", "Pink", "Green", "Blue"],
  img: "character-icons/falcon/"
}, {
  id: 12,
  name: "Peach",
  shortName: "Peach",
  colors: ["Default", "Daisy", "White", "Blue", "Green"],
  img: "character-icons/peach/"
}, {
  id: 16,
  name: "Samus",
  shortName: "Samus",
  colors: ["Default", "Pink", "Black", "Green", "Purple"],
  img: "character-icons/samus/"
},{
  id: 17,
  name: "Yoshi",
  shortName: "Yoshi",
  colors: ["Default", "Red", "Blue", "Yellow", "Pink", "Cyan"],
  img: "character-icons/yoshi/"
}, {
  id: 7,
  name: "Luigi",
  shortName: "Luigi",
  colors: ["Default", "White", "Blue", "Pink"],
  img: "character-icons/luigi/"
}, {
  id: 13,
  name: "Pikachu",
  shortName: "Pikachu",
  colors: ["Default", "Red", "Party_Hat", "Fedora"],
  img: "character-icons/pikachu/"
},{
  id: 1,
  name: "Donkey Kong",
  shortName: "DK",
  colors: ["Default", "Black", "Red", "Blue", "Green"],
  img: "character-icons/dk/"
}, {
  id: 3,
  name: "Mr. Game & Watch",
  shortName: "G&W",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/gnw/"
}, {
  id: 4,
  name: "Kirby",
  shortName: "Kirby",
  colors: ["Default", "Yellow", "Blue", "Red", "Green", "White"],
  img: "character-icons/kirby/"
}, {
  id: 5,
  name: "Bowser",
  shortName: "Bowser",
  colors: ["Default", "Red", "Blue", "Black"],
  img: "character-icons/bowser/"
}, {
  id: 6,
  name: "Link",
  shortName: "Link",
  colors: ["Default", "Red", "Blue", "Black", "White"],
  img: "character-icons/link/"
}, {
  id: 8,
  name: "Mario",
  shortName: "Mario",
  colors: ["Default", "Yellow", "Black", "Blue", "Green"],
  img: "character-icons/mario/"
}, {
  id: 10,
  name: "Mewtwo",
  shortName: "Mewtwo",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/mewtwo/"
}, {
  id: 11,
  name: "Ness",
  shortName: "Ness",
  colors: ["Default", "Yellow", "Blue", "Green"],
  img: "character-icons/ness/"
}, {
  id: 14,
  name: "Ice Climbers",
  shortName: "ICs",
  colors: ["Default", "Green", "Orange", "Red"],
  img: "character-icons/ics/"
}, {
  id: 18,
  name: "Zelda",
  shortName: "Zelda",
  colors: ["Default", "Red", "Blue", "Green", "White"],
  img: "character-icons/zelda/"
}, {
  id: 21,
  name: "Young Link",
  shortName: "YLink",
  colors: ["Default", "Red", "Blue", "White", "Black"],
  img: "character-icons/yl/"
}, {
  id: 22,
  name: "Dr. Mario",
  shortName: "Doc",
  colors: ["Default", "Red", "Blue", "Green", "Black"],
  img: "character-icons/doc/"
}, {
  id: 23,
  name: "Roy",
  shortName: "Roy",
  colors: ["Default", "Red", "Blue", "Green", "Yellow"],
  img: "character-icons/roy/"
}, {
  id: 24,
  name: "Pichu",
  shortName: "Pichu",
  colors: ["Default", "Red", "Blue", "Green"],
  img: "character-icons/pichu/"
}, {
  id: 25,
  name: "Ganondorf",
  shortName: "Ganon",
  colors: ["Default", "Red", "Blue", "Green", "Purple"],
  img: "character-icons/ganon/"
}];

const fastFallers = [0,2,20]
const lowTiers = [1,3,4,5,6,8,10,11,18,21,22,23,24,25]

export { characters, sortedCharacters, fastFallers, lowTiers }
