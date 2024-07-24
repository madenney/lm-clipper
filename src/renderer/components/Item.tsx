
import { useState, Dispatch, SetStateAction, useEffect } from 'react'
import '../styles/Item.css'
import ipcBridge from 'renderer/ipcBridge'
import {
  ClipInterface,
  FileInterface
} from '../../constants/types'

import { characters } from '../../constants/characters'
import { stages } from '../../constants/stages'

const images: { [key: string]: any } = {}

type ItemProps = {
  item: ClipInterface | FileInterface
  index: number
}

export default function Item({ item, index }: ItemProps) {

    const darkStages = [2, 3, 31, 32]
    let comboer, comboee
    const { stage, players } = item

    if(isClipInterface(item)){
        comboer = item.comboer
        comboee = item.comboee
    }
    
    if (!comboer && !comboee && !players) throw Error('?')

    // TODO - add all the stage images or just add an alt image
    let stageTag = "unknown"
    if (stages[stage as keyof typeof stages]){
        stageTag = stages[stage as keyof typeof stages].tag
    }
    const stageImage = images[`stage_${stageTag}`]
    const arrowImage =
    darkStages.indexOf(stage) !== -1
        ? images['whiteNextArrow']
        : images['nextArrow']
    let p1Image
    let p2Image
    if (comboer && comboee) {
    p1Image =
        images[
        `${characters[comboer.characterId].shortName}_${
            characters[comboer.characterId].colors[comboer.characterColor]
        }`
        ]
    p2Image =
        images[
        `${characters[comboee.characterId].shortName}_${
            characters[comboee.characterId].colors[comboee.characterColor]
        }`
        ]
    } else if (players) {
    p1Image =
        images[
        `${characters[players[0].characterId].shortName}_${
            characters[players[0].characterId].colors[
            players[0].characterColor
            ]
        }`
        ]
    p2Image =
        images[
        `${characters[players[1].characterId].shortName}_${
            characters[players[1].characterId].colors[
            players[1].characterColor
            ]
        }`
        ]
    }

    return <div className="item" onClick={() => showClip(item)}>
        <div className='result-image-container'>
        {/* <div className="characters-container">
            <img alt="img_here" className="char1-image" src={p1Image} />
            <img alt="img_here" className="arrow-image" src={arrowImage} />
            <img alt="img_here" className="char2-image" src={p2Image} />
        </div> */}
            <img alt="img_here" className="stage-image" src={stageImage} />
        </div>
    </div>

    return (
        <div className="item" onClick={() => showClip(item)} key={index}>
            <div className="result-image-container">
            <div className="characters-container">
                <img alt="img_here" className="char1-image" src={p1Image} />
                <img alt="img_here" className="arrow-image" src={arrowImage} />
                <img alt="img_here" className="char2-image" src={p2Image} />
            </div>
            <img alt="img_here" className="stage-image" src={stageImage} />
            </div>
            <div className="result-info-container">
            {/* {item.combo && item.combo.moves ? (
                <div className="result-info-row">
                <div className="result-info-label">Moves:</div>
                <div className="result-info-data">
                    {item.combo.moves.length}
                </div>
                </div>
            ) : (
                ''
            )} */}
            {item.startFrame && item.endFrame ? (
                <div className="result-info-row">
                <div className="result-info-label">Length:</div>
                <div className="result-info-data">
                    {/* eslint-disable-next-line prettier/prettier */}
                    {`${((item.endFrame - item.startFrame) / 60).toFixed(1)} s`}
                </div>
                </div>
            ) : (
                ''
            )}
            </div>
        </div>
    )
  
}

type MyType = ClipInterface | FileInterface;

function isClipInterface(obj: MyType): obj is ClipInterface {
    return (obj as ClipInterface).comboer !== undefined;
}

function showClip(item: FileInterface | ClipInterface) {
    console.log(item)
    // if (!localStorage.ssbmIsoPath) throw 'Error: No ssbm iso path'
    // if (!localStorage.dolphinPath) throw 'Error: No dolphin path'

    // const { path: slpPath, startFrame, endFrame } = item
    // console.log(slpPath, startFrame, endFrame)
    // const dolphinConfig = {
    // mode: 'normal',
    // replay: slpPath,
    // startFrame,
    // endFrame,
    // isRealTimeMode: false,
    // commandId: `${crypto.randomBytes(12).toString('hex')}`,
    // }
    // const tmpDir = path.resolve(
    // os.tmpdir(),
    // `tmp-${crypto.randomBytes(12).toString('hex')}`
    // )
    // fs.mkdirSync(tmpDir)
    // const filePath = path.resolve(tmpDir, 'dolphinConfig.json')
    // fsPromises.writeFile(filePath, JSON.stringify(dolphinConfig))
    // const args = ['-i', filePath, '-b', '-e', localStorage.ssbmIsoPath]
    // const process = spawn(localStorage.dolphinPath, args)
    // // TODO: Kill process when clip finishes playing and delete JSON file from tmp
    // setTimeout(() => {
    // process.kill()
    // }, 3000)
}





// There's obviously a better way to do this but I don't know it
import NextArrow from '../../images/next.png'
images['nextArrow'] = NextArrow
import WhiteNextArrow from '../../images/whitenext.png'
images['whiteNextArrow'] = WhiteNextArrow
import Falcon_Default from '../../images/character-icons/falcon/Default.png'
images['Falcon_Default'] = Falcon_Default
import Falcon_Black from '../../images/character-icons/falcon/Black.png'
images['Falcon_Black'] = Falcon_Black
import Falcon_Red from '../../images/character-icons/falcon/Red.png'
images['Falcon_Red'] = Falcon_Red
import Falcon_Pink from '../../images/character-icons/falcon/Pink.png'
images['Falcon_Pink'] = Falcon_Pink
import Falcon_Green from '../../images/character-icons/falcon/Green.png'
images['Falcon_Green'] = Falcon_Green
import Falcon_Blue from '../../images/character-icons/falcon/Blue.png'
images['Falcon_Blue'] = Falcon_Blue
import DK_Default from '../../images/character-icons/dk/Default.png'
images['DK_Default'] = DK_Default
import DK_Black from '../../images/character-icons/dk/Black.png'
images['DK_Black'] = DK_Black
import DK_Red from '../../images/character-icons/dk/Red.png'
images['DK_Red'] = DK_Red
import DK_Blue from '../../images/character-icons/dk/Blue.png'
images['DK_Blue'] = DK_Blue
import DK_Green from '../../images/character-icons/dk/Green.png'
images['DK_Green'] = DK_Green
import Fox_Default from '../../images/character-icons/fox/Default.png'
images['Fox_Default'] = Fox_Default
import Fox_Red from '../../images/character-icons/fox/Red.png'
images['Fox_Red'] = Fox_Red
import Fox_Blue from '../../images/character-icons/fox/Blue.png'
images['Fox_Blue'] = Fox_Blue
import Fox_Green from '../../images/character-icons/fox/Green.png'
images['Fox_Green'] = Fox_Green
import GnW_Default from '../../images/character-icons/gnw/Default.png'
images['GnW_Default'] = GnW_Default
import GnW_Red from '../../images/character-icons/gnw/Red.png'
images['GnW_Red'] = GnW_Red
import GnW_Blue from '../../images/character-icons/gnw/Blue.png'
images['GnW_Blue'] = GnW_Blue
import GnW_Green from '../../images/character-icons/gnw/Green.png'
images['GnW_Green'] = GnW_Green
import Kirby_Default from '../../images/character-icons/kirby/Default.png'
images['Kirby_Default'] = Kirby_Default
import Kirby_Yellow from '../../images/character-icons/kirby/Yellow.png'
images['Kirby_Yellow'] = Kirby_Yellow
import Kirby_Blue from '../../images/character-icons/kirby/Blue.png'
images['Kirby_Blue'] = Kirby_Blue
import Kirby_Red from '../../images/character-icons/kirby/Red.png'
images['Kirby_Red'] = Kirby_Red
import Kirby_Green from '../../images/character-icons/kirby/Green.png'
images['Kirby_Green'] = Kirby_Green
import Kirby_White from '../../images/character-icons/kirby/White.png'
images['Kirby_White'] = Kirby_White
import Bowser_Default from '../../images/character-icons/bowser/Default.png'
images['Bowser_Default'] = Bowser_Default
import Bowser_Red from '../../images/character-icons/bowser/Red.png'
images['Bowser_Red'] = Bowser_Red
import Bowser_Blue from '../../images/character-icons/bowser/Blue.png'
images['Bowser_Blue'] = Bowser_Blue
import Bowser_Black from '../../images/character-icons/bowser/Black.png'
images['Bowser_Black'] = Bowser_Black
import Link_Default from '../../images/character-icons/link/Default.png'
images['Link_Default'] = Link_Default
import Link_Red from '../../images/character-icons/link/Red.png'
images['Link_Red'] = Link_Red
import Link_Blue from '../../images/character-icons/link/Blue.png'
images['Link_Blue'] = Link_Blue
import Link_Black from '../../images/character-icons/link/Black.png'
images['Link_Black'] = Link_Black
import Link_White from '../../images/character-icons/link/White.png'
images['Link_White'] = Link_White
import Luigi_Default from '../../images/character-icons/luigi/Default.png'
images['Luigi_Default'] = Luigi_Default
import Luigi_White from '../../images/character-icons/luigi/White.png'
images['Luigi_White'] = Luigi_White
import Luigi_Blue from '../../images/character-icons/luigi/Blue.png'
images['Luigi_Blue'] = Luigi_Blue
import Luigi_Pink from '../../images/character-icons/luigi/Pink.png'
images['Luigi_Pink'] = Luigi_Pink
import Mario_Default from '../../images/character-icons/mario/Default.png'
images['Mario_Default'] = Mario_Default
import Mario_Yellow from '../../images/character-icons/mario/Yellow.png'
images['Mario_Yellow'] = Mario_Yellow
import Mario_Black from '../../images/character-icons/mario/Black.png'
images['Mario_Black'] = Mario_Black
import Mario_Blue from '../../images/character-icons/mario/Blue.png'
images['Mario_Blue'] = Mario_Blue
import Mario_Green from '../../images/character-icons/mario/Green.png'
images['Mario_Green'] = Mario_Green
import Marth_Default from '../../images/character-icons/marth/Default.png'
images['Marth_Default'] = Marth_Default
import Marth_Red from '../../images/character-icons/marth/Red.png'
images['Marth_Red'] = Marth_Red
import Marth_Green from '../../images/character-icons/marth/Green.png'
images['Marth_Green'] = Marth_Green
import Marth_Black from '../../images/character-icons/marth/Black.png'
images['Marth_Black'] = Marth_Black
import Marth_White from '../../images/character-icons/marth/White.png'
images['Marth_White'] = Marth_White
import Mewtwo_Default from '../../images/character-icons/mewtwo/Default.png'
images['Mewtwo_Default'] = Mewtwo_Default
import Mewtwo_Red from '../../images/character-icons/mewtwo/Red.png'
images['Mewtwo_Red'] = Mewtwo_Red
import Mewtwo_Blue from '../../images/character-icons/mewtwo/Blue.png'
images['Mewtwo_Blue'] = Mewtwo_Blue
import Mewtwo_Green from '../../images/character-icons/mewtwo/Green.png'
images['Mewtwo_Green'] = Mewtwo_Green
import Ness_Default from '../../images/character-icons/ness/Default.png'
images['Ness_Default'] = Ness_Default
import Ness_Yellow from '../../images/character-icons/ness/Yellow.png'
images['Ness_Yellow'] = Ness_Yellow
import Ness_Blue from '../../images/character-icons/ness/Blue.png'
images['Ness_Blue'] = Ness_Blue
import Ness_Green from '../../images/character-icons/ness/Green.png'
images['Ness_Green'] = Ness_Green
import Peach_Default from '../../images/character-icons/peach/Default.png'
images['Peach_Default'] = Peach_Default
import Peach_Daisy from '../../images/character-icons/peach/Daisy.png'
images['Peach_Daisy'] = Peach_Daisy
import Peach_White from '../../images/character-icons/peach/White.png'
images['Peach_White'] = Peach_White
import Peach_Blue from '../../images/character-icons/peach/Blue.png'
images['Peach_Blue'] = Peach_Blue
import Peach_Green from '../../images/character-icons/peach/Green.png'
images['Peach_Green'] = Peach_Green
import Pikachu_Default from '../../images/character-icons/pikachu/Default.png'
images['Pikachu_Default'] = Pikachu_Default
import Pikachu_Red from '../../images/character-icons/pikachu/Red.png'
images['Pikachu_Red'] = Pikachu_Red
import Pikachu_Party_Hat from '../../images/character-icons/pikachu/Party_Hat.png'
images['Pikachu_Party_Hat'] = Pikachu_Party_Hat
import Pikachu_Fedora from '../../images/character-icons/pikachu/Fedora.png'
images['Pikachu_Fedora'] = Pikachu_Fedora
import ICs_Default from '../../images/character-icons/ics/Default.png'
images['ICs_Default'] = ICs_Default
import ICs_Green from '../../images/character-icons/ics/Green.png'
images['ICs_Green'] = ICs_Green
import ICs_Orange from '../../images/character-icons/ics/Orange.png'
images['ICs_Orange'] = ICs_Orange
import ICs_Red from '../../images/character-icons/ics/Red.png'
images['ICs_Red'] = ICs_Red
import Puff_Default from '../../images/character-icons/puff/Default.png'
images['Puff_Default'] = Puff_Default
import Puff_Flower from '../../images/character-icons/puff/Flower.png'
images['Puff_Flower'] = Puff_Flower
import Puff_Bow from '../../images/character-icons/puff/Bow.png'
images['Puff_Bow'] = Puff_Bow
import Puff_Headband from '../../images/character-icons/puff/Headband.png'
images['Puff_Headband'] = Puff_Headband
import Puff_Crown from '../../images/character-icons/puff/Crown.png'
images['Puff_Crown'] = Puff_Crown
import Samus_Default from '../../images/character-icons/samus/Default.png'
images['Samus_Default'] = Samus_Default
import Samus_Pink from '../../images/character-icons/samus/Pink.png'
images['Samus_Pink'] = Samus_Pink
import Samus_Black from '../../images/character-icons/samus/Black.png'
images['Samus_Black'] = Samus_Black
import Samus_Green from '../../images/character-icons/samus/Green.png'
images['Samus_Green'] = Samus_Green
import Samus_Purple from '../../images/character-icons/samus/Purple.png'
images['Samus_Purple'] = Samus_Purple
import Yoshi_Default from '../../images/character-icons/yoshi/Default.png'
images['Yoshi_Default'] = Yoshi_Default
import Yoshi_Red from '../../images/character-icons/yoshi/Red.png'
images['Yoshi_Red'] = Yoshi_Red
import Yoshi_Blue from '../../images/character-icons/yoshi/Blue.png'
images['Yoshi_Blue'] = Yoshi_Blue
import Yoshi_Yellow from '../../images/character-icons/yoshi/Yellow.png'
images['Yoshi_Yellow'] = Yoshi_Yellow
import Yoshi_Pink from '../../images/character-icons/yoshi/Pink.png'
images['Yoshi_Pink'] = Yoshi_Pink
import Yoshi_Cyan from '../../images/character-icons/yoshi/Cyan.png'
images['Yoshi_Cyan'] = Yoshi_Cyan
import Zelda_Default from '../../images/character-icons/zelda/Default.png'
images['Zelda_Default'] = Zelda_Default
import Zelda_Red from '../../images/character-icons/zelda/Red.png'
images['Zelda_Red'] = Zelda_Red
import Zelda_Blue from '../../images/character-icons/zelda/Blue.png'
images['Zelda_Blue'] = Zelda_Blue
import Zelda_Green from '../../images/character-icons/zelda/Green.png'
images['Zelda_Green'] = Zelda_Green
import Zelda_White from '../../images/character-icons/zelda/White.png'
images['Zelda_White'] = Zelda_White
import Sheik_Default from '../../images/character-icons/sheik/Default.png'
images['Sheik_Default'] = Sheik_Default
import Sheik_Red from '../../images/character-icons/sheik/Red.png'
images['Sheik_Red'] = Sheik_Red
import Sheik_Blue from '../../images/character-icons/sheik/Blue.png'
images['Sheik_Blue'] = Sheik_Blue
import Sheik_Green from '../../images/character-icons/sheik/Green.png'
images['Sheik_Green'] = Sheik_Green
import Sheik_White from '../../images/character-icons/sheik/White.png'
images['Sheik_White'] = Sheik_White
import Falco_Default from '../../images/character-icons/falco/Default.png'
images['Falco_Default'] = Falco_Default
import Falco_Red from '../../images/character-icons/falco/Red.png'
images['Falco_Red'] = Falco_Red
import Falco_Blue from '../../images/character-icons/falco/Blue.png'
images['Falco_Blue'] = Falco_Blue
import Falco_Green from '../../images/character-icons/falco/Green.png'
images['Falco_Green'] = Falco_Green
import YLink_Default from '../../images/character-icons/yl/Default.png'
images['YLink_Default'] = YLink_Default
import YLink_Red from '../../images/character-icons/yl/Red.png'
images['YLink_Red'] = YLink_Red
import YLink_Blue from '../../images/character-icons/yl/Blue.png'
images['YLink_Blue'] = YLink_Blue
import YLink_White from '../../images/character-icons/yl/White.png'
images['YLink_White'] = YLink_White
import YLink_Black from '../../images/character-icons/yl/Black.png'
images['YLink_Black'] = YLink_Black
import Doc_Default from '../../images/character-icons/doc/Default.png'
images['Doc_Default'] = Doc_Default
import Doc_Red from '../../images/character-icons/doc/Red.png'
images['Doc_Red'] = Doc_Red
import Doc_Blue from '../../images/character-icons/doc/Blue.png'
images['Doc_Blue'] = Doc_Blue
import Doc_Green from '../../images/character-icons/doc/Green.png'
images['Doc_Green'] = Doc_Green
import Doc_Black from '../../images/character-icons/doc/Black.png'
images['Doc_Black'] = Doc_Black
import Roy_Default from '../../images/character-icons/roy/Default.png'
images['Roy_Default'] = Roy_Default
import Roy_Red from '../../images/character-icons/roy/Red.png'
images['Roy_Red'] = Roy_Red
import Roy_Blue from '../../images/character-icons/roy/Blue.png'
images['Roy_Blue'] = Roy_Blue
import Roy_Green from '../../images/character-icons/roy/Green.png'
images['Roy_Green'] = Roy_Green
import Roy_Yellow from '../../images/character-icons/roy/Yellow.png'
images['Roy_Yellow'] = Roy_Yellow
import Pichu_Default from '../../images/character-icons/pichu/Default.png'
images['Pichu_Default'] = Pichu_Default
import Pichu_Red from '../../images/character-icons/pichu/Red.png'
images['Pichu_Red'] = Pichu_Red
import Pichu_Blue from '../../images/character-icons/pichu/Blue.png'
images['Pichu_Blue'] = Pichu_Blue
import Pichu_Green from '../../images/character-icons/pichu/Green.png'
images['Pichu_Green'] = Pichu_Green
import Ganon_Default from '../../images/character-icons/ganon/Default.png'
images['Ganon_Default'] = Ganon_Default
import Ganon_Red from '../../images/character-icons/ganon/Red.png'
images['Ganon_Red'] = Ganon_Red
import Ganon_Blue from '../../images/character-icons/ganon/Blue.png'
images['Ganon_Blue'] = Ganon_Blue
import Ganon_Green from '../../images/character-icons/ganon/Green.png'
images['Ganon_Green'] = Ganon_Green
import Ganon_Purple from '../../images/character-icons/ganon/Purple.png'
images['Ganon_Purple'] = Ganon_Purple
import stage_fod from '../../images/stages/fountain.jpg'
images['stage_fod'] = stage_fod
import stage_ps from '../../images/stages/stadium.jpg'
images['stage_ps'] = stage_ps
import stage_pc from '../../images/stages/nonlegal.jpg'
images['stage_pc'] = stage_pc
import stage_kj from '../../images/stages/nonlegal.jpg'
images['stage_kj'] = stage_kj
import stage_bs from '../../images/stages/nonlegal.jpg'
images['stage_bs'] = stage_bs
import stage_cr from '../../images/stages/nonlegal.jpg'
images['stage_cr'] = stage_cr
import stage_ys from '../../images/stages/yoshis.jpg'
images['stage_ys'] = stage_ys
import stage_on from '../../images/stages/nonlegal.jpg'
images['stage_on'] = stage_on
import stage_mc from '../../images/stages/nonlegal.jpg'
images['stage_mc'] = stage_mc
import stage_rc from '../../images/stages/nonlegal.jpg'
images['stage_rc'] = stage_rc
import stage_jj from '../../images/stages/nonlegal.jpg'
images['stage_jj'] = stage_jj
import stage_gb from '../../images/stages/nonlegal.jpg'
images['stage_gb'] = stage_gb
import stage_ht from '../../images/stages/nonlegal.jpg'
images['stage_ht'] = stage_ht
import stage_bd from '../../images/stages/nonlegal.jpg'
images['stage_bd'] = stage_bd
import stage_yi from '../../images/stages/nonlegal.jpg'
images['stage_yi'] = stage_yi
import stage_gg from '../../images/stages/nonlegal.jpg'
images['stage_gg'] = stage_gg
import stage_fs from '../../images/stages/nonlegal.jpg'
images['stage_fs'] = stage_fs
import stage_mk from '../../images/stages/nonlegal.jpg'
images['stage_mk'] = stage_mk
import stage_mk2 from '../../images/stages/nonlegal.jpg'
images['stage_mk2'] = stage_mk2
import stage_vn from '../../images/stages/nonlegal.jpg'
images['stage_vn'] = stage_vn
import stage_pf from '../../images/stages/nonlegal.jpg'
images['stage_pf'] = stage_pf
import stage_bb from '../../images/stages/nonlegal.jpg'
images['stage_bb'] = stage_bb
import stage_im from '../../images/stages/nonlegal.jpg'
images['stage_im'] = stage_im
import stage_it from '../../images/stages/nonlegal.jpg'
images['stage_it'] = stage_it
import stage_fz from '../../images/stages/nonlegal.jpg'
images['stage_fz'] = stage_fz
import stage_dl from '../../images/stages/dreamland.jpg'
images['stage_dl'] = stage_dl
import stage_yi64 from '../../images/stages/nonlegal.jpg'
images['stage_yi64'] = stage_yi64
import stage_kj64 from '../../images/stages/nonlegal.jpg'
images['stage_kj64'] = stage_kj64
import stage_bf from '../../images/stages/battlefield.jpg'
images['stage_bf'] = stage_bf
import stage_fd from '../../images/stages/finaldestination.jpg'
images['stage_fd'] = stage_fd
