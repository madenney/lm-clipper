
printf "\n Custom Build Script"

printf "\n npm run build"
npm run build

printf "\n cp -R src/main/pyscripts release/app/dist/main/."
cp -R src/main/pyscripts release/app/dist/main/.

printf "\n cd release/app"
cd release/app

printf "\n conveyor make site"
conveyor make site --overwrite

printf "\n Done."
