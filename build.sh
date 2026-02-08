
printf "\n Custom Build Script\n\n"

printf "\n ============================================================ \n"
printf " ======================  npm run build ======================"
printf "\n ============================================================ \n"
npm run build

printf "\n\n\n\n ============================================================ \n"
printf " ===== cp -R src/main/pyscripts release/app/dist/main/. ====="
printf "\n ============================================================ \n"
if [ -d src/main/pyscripts ]; then
  cp -R src/main/pyscripts release/app/dist/main/.
else
  printf " (skipped — src/main/pyscripts not found)\n"
fi

printf "\n\n\n\n ============================================================ \n"
printf " ============== TODO: COPY ICONS INTO DIST TOO =============="
printf "\n ============================================================ \n"


printf "\n\n\n\n ============================================================\n"
printf " ====================== cd release/app ======================"
printf "\n ============================================================ \n"
cd release/app

printf "\n\n\n\n ============================================================\n"
printf " ============== conveyor make site --overwrite =============="
printf "\n ============================================================ \n"
conveyor make site --overwrite

printf "\n\n\n\n Done.\n\n"
