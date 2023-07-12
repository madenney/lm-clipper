
const fs = require("fs")
const { lstatSync, readdirSync, statSync, mkdirSync, readdir, fstat } = require("fs")
const path = require("path")

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

function pad(num, size) {
  num = num.toString();
  while (num.length < size) num = "0" + num;
  return num;
}

function readableDate(timestamp){
  const d = new Date(parseInt(timestamp));
  return `${d.getMonth()+1}-${d.getDate()}-${d.getFullYear()}`
}

function objectsMatch(obj1,obj2){
  if( Object.keys(obj1).length != Object.keys(obj2).length) return false
  let match = true;
  Object.keys(obj1).forEach(key => {
    if(obj2[key] != obj1[key] ) match = false
  })
  return match
}

function shuffleArray(_array) {
  const array = _array.slice(0)
  var currentIndex = array.length, temporaryValue, randomIndex;

  // While there remain elements to shuffle...
  while (0 !== currentIndex) {

    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex -= 1;

    // And swap it with the current element.
    temporaryValue = array[currentIndex];
    array[currentIndex] = array[randomIndex];
    array[randomIndex] = temporaryValue;
  }
  return array;
}

const getSlpFilePaths = (_paths) => {
	const paths = Array.isArray(_paths) ? _paths : [_paths];
	let files = []
	paths.forEach(p => {
		const fileInfo = lstatSync(p);
		if(fileInfo.isDirectory()){
			readdirSync(p).forEach(p1 => {
				files = files.concat(getSlpFilePaths(path.resolve(p,p1)))
			});
		}
		if(fileInfo.isFile() && path.extname(p) === ".slp"){
			files.push(p);
		}
	})
	return files;
}

function importAll(r) {
	let images = {};
  r.keys().forEach((item, index) => { images[item.replace('./', '')] = r(item); });
	return images
}

function getDistance(x1, y1, x2, y2){
  let y = x2 - x1;
  let x = y2 - y1;
  
  return Math.sqrt(x * x + y * y);
}

export default {
	...require("./file"),
	...require("./overlay"),
  getSlpFilePaths,
  asyncForEach,
  pad,
  readableDate,
  objectsMatch,
  shuffleArray,
  importAll,
  getDistance
}
