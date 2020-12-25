'use strict';

import fs from 'fs';
import path from 'path';
import csv from 'async-csv';

import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';
const { Pool } = pg;
const pool = new Pool();

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// global objects
const tokenIds = {};
const exprIds = {};
const transIds = {};
const featureIds = {};
const phraseIds = {};
//
// https://www.loc.gov/standards/iso639-2/php/code_list.php
const langCodes = {
	"тадж": "tgk",
	"англ": "eng",
	"фин": "fin",
	"бур": "bua",
	"ивр": "heb",
	"ит": "ita",
	"слвн": "slv",
	"русский": "rus"
}; // nno | nob


const mappingRuEn = {
  'ДФ': "unit",
  'требуется продолжение': "extrequired",
  'основная семантика': "semantics1",
  'дополнительная семантика': "semantics",
  'речевой акт 1 (для трехчастных)': "act1",
  'тип речевого акта (собеседник)': "actclass",
  'о ситуации': "situation",
  'структура': "parts",
  'интонация' : "intonation",
  'продолжение' : "extension",
  'модификации' : "mods",
  'жестикуляция' :"gest",
  'активный орган': "organ",
  'переводные аналоги': "translations",
  'Примеры': "examples",
  'Аудио' : "audio",
  'Видео': "video",
  'уст.|груб.|нейтр.': "style",
  'Комментарий': "comment",
  'конструкция': "construction",
  'ссылка на конструктикон' : "link"
};

const schemes = {
 "phrases": `CREATE TABLE phrases (pid SERIAL PRIMARY KEY, phrase jsonb)`,
 "exprs": `CREATE TABLE exprs (eid SERIAL PRIMARY KEY, expr jsonb UNIQUE)`,
 "tokens": `CREATE TABLE tokens (id SERIAL PRIMARY KEY, token text UNIQUE)`,
 "units": `CREATE TABLE units (
    id SERIAL PRIMARY KEY,
    pid integer not null,
    extrequired boolean not null default false,
    semantics jsonb,
    act1 jsonb, 
    actclass jsonb,
    situation text,
    parts boolean not null default false,
    intonation integer,
    extension jsonb,
    mods text,
    gest jsonb,
    organ jsonb,
    translations jsonb,
    examples text,
    audio text,
    video text,
    style integer,
    comment text,
    construction text,
    link text,
	CONSTRAINT fk_phrases
      FOREIGN KEY(pid) 
	  REFERENCES phrases(pid)
	)`,	
	"features":
	`CREATE TABLE features (
		id SERIAL PRIMARY KEY,
		groupid text,
		ru text not null,
		en text,
		UNIQUE (groupid, ru)
	)`,
	"translations":
	`CREATE TABLE translations (
		id SERIAL PRIMARY KEY,
		excerpt text not null,
		lang text not null,
		UNIQUE (excerpt, lang)
	)`
};

const exprsInsert = `INSERT INTO exprs (expr) VALUES($1) RETURNING eid`;
const phrasesInsert = `INSERT INTO phrases (phrase) VALUES($1) RETURNING pid`;
const tokensInsert = `INSERT INTO tokens (token) VALUES($1) RETURNING id`;
const transInsert = `INSERT INTO translations (excerpt, lang) VALUES($1, $2) RETURNING id`;
const featuresInsert = `INSERT INTO features (groupid, ru) VALUES($1, $2) RETURNING id`;
const unitsInsert = `INSERT INTO units (pid, extrequired, semantics, act1, 
					actclass, situation, parts, intonation, extension, mods, gest, organ, translations)
                    VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    RETURNING *`;

async function checkFeature(fld, content){
     // select semantics1, semantics2->0 from units;
    // if (["semantics1", "semantics2"].includes(fld)){
        // fld = "semantics";
    // }
    const uuid = fld+content;
    if (!Reflect.getOwnPropertyDescriptor(featureIds, uuid)) {
        try {
            const result  = await pool.query(featuresInsert, [fld, content]);
            featureIds[uuid] = result.rows[0].id;
        } catch (e){
            console.error(e.detail);
        }
    }
    return featureIds[uuid];
}

async function checkFeatureArray(fld, content) {
    const thisArr = content.split("|");
    const thisArrIds = [];
    for (let s=0; s < thisArr.length; s++) {
        if (thisArr[s]) {
            thisArrIds.push(await checkFeature(fld, thisArr[s]));
        }
    }
    return JSON.stringify(thisArrIds);
}

async function vectorizeTokens(content){
    // console.time();
    // those chains of loops are to force code to run PG queries sequentially
    const unitsArr = content.split("|");
    const unitsArrVector = [];
	const exprsArr = [];
	
    for (let i=0; i < unitsArr.length; i++) {
        const tokensArr = unitsArr[i].split(/\s|(?=-)/g);
        const tokensArrVector = [];
        for (let t=0; t < tokensArr.length; t++) {
            const tkn = tokensArr[t].trim();
            if (!Reflect.getOwnPropertyDescriptor(tokenIds, tkn)) {
                try {
                    const result  = await pool.query(tokensInsert, [tkn]);
                    tokenIds[tkn] = result.rows[0].id;
                } catch (e){
                    console.error(e.detail);
                }
            }
            tokensArrVector.push(tokenIds[tkn]);
        }
		
		const exprSerialized = JSON.stringify(tokensArrVector);
		if (!Reflect.getOwnPropertyDescriptor(exprIds, exprSerialized)) {
			try {
				const result  = await pool.query(exprsInsert, [exprSerialized]);
				exprIds[exprSerialized] = result.rows[0].eid;
			} catch (e){
				console.error(e.detail);
			}					
		}
		// console.error(unitsArr[i], exprIds[exprSerialized]);
		exprsArr.push(exprIds[exprSerialized])
        unitsArrVector.push(tokensArrVector);
    }
    // console.timeEnd();
    return [JSON.stringify(unitsArrVector), exprsArr[0], JSON.stringify(exprsArr)];
}

async function processTranslations(fld, content){
	const cleaned = content.replace(/\|/g, '');
	let arr  = cleaned.split(/(?<=]])\s*/g);
	const thisArrTransIds = [];
	if (cleaned.length) {
		for (let ii=0; ii<arr.length; ii++){
			const transPlusLang  = arr[ii].split("[[");
				if (transPlusLang.length!==2) {
					console.error(`ERROR: ${fld} <DOES NOT MATCH> ${content}`);
				} else {
					// console.log(transPlusLang[0], transPlusLang[1].slice(0, -3) );
					const [trans, langRu] = transPlusLang;
					const langRussian = langRu.replace(/\.?\]\]$/, '');
					
					const pdLang  = Reflect.getOwnPropertyDescriptor(langCodes, langRussian);
					if (pdLang){
						if (pdLang.value === "rus") {
							console.error(`ERROR: ${fld} <RUSSIAN> ${content}`);
						}
						const pdTrans = Reflect.getOwnPropertyDescriptor(transIds, trans);
						if (!pdTrans) {
							try {
								const result  = await pool.query(transInsert, [trans, pdLang.value]);
								transIds[trans] = result.rows[0].id;
							} catch (e) {
								console.error(e);
							}
						} 
						thisArrTransIds.push(transIds[trans]);
					} else {
						console.error("ERROR", fld, "<NOT IN LANG LIST>",langRussian, "■",content);
					}
				}
		}						
	}
	return JSON.stringify(thisArrTransIds);
}

async function processExamples(fld, content){
	const cleaned = content.replace(/\|/g, '').trim();
	let arr  = cleaned.split(/(?<=]])\s*/g);
	const thisArrTransIds = [];
	if (cleaned.length) {
		for (let ii=0; ii<arr.length; ii++){
			const example  = arr[ii].trim().replace(/--|-/, '–');
			const transPlusLang  = example.split("[[");
				if (transPlusLang.length!==2) {
					console.error(`ERROR: ${fld} len=${transPlusLang.length} <DOES NOT MATCH> |${transPlusLang}|:\n${example}\n►${content}◄`);
					// console.error(arr);
				} else {
					// console.log(transPlusLang[0], transPlusLang[1].slice(0, -3) );
					const [trans, langRu] = transPlusLang;
					const langRussian = langRu.replace(/\.?\]\]$/, '');
					
					const textPlusSource  = trans.split("[");
					
					const info = {};
					// console.log("--------------------------------");
					// console.log("[text]", textPlusSource);
					info["lang"] = langRussian;
					
					if (textPlusSource.length>1) {
						const srcAndDate = textPlusSource[1].trim();
						let matches = srcAndDate.match(/^(.*?)(\([\d–\.]+\))\]$/);
						
						if (!matches){
							const matches  = srcAndDate.match(/^(.*?)\s*\/\/\s*«(.*?)»\,\s+([\d–\.]+)\]$/);
							if (matches) {
								console.log(">>", matches[1]);
								console.log(">>", matches[2], "■",matches[3]);
							} else {
								console.error("NO", srcAndDate);
							}
						} else {
							// const dotSplitter = matches[1].lastIndexOf();
							const [author, book, rest] = matches[1].split('.');
							if (rest) {
								console.error(matches[1]);
							} else {
								info["author"] = author.trim();
								info["book"] = book.trim();
								info["date"] = matches[2].trim();
							}
						}
						
						if (matches) {
							// console.log(matches);
							// console.log(">",src);
							// console.log(">", date.split(')')[0]);
						} else {
							
							// const matches  = srcAndDate.match(/^(.*?)\s*\/\/\s*«(.*?)»\,\s+(\d+)\]$/);
							// if (matches) {
								// console.log(">>", matches[1]);
								// console.log(">>", matches[2], matches[3]);
							// } else {
								// console.log("NO DATE", textPlusSource[1], matches);
							// }
						}
						console.log(info);
					} else {
						// console.error("NO SRC", textPlusSource.length, textPlusSource);
					}
					
					
					
					const pdLang  = Reflect.getOwnPropertyDescriptor(langCodes, langRussian);
					if (pdLang){
						// if (pdLang.value === "rus") {
							// console.error(`ERROR: ${fld} <RUSSIAN> ${content}`);
						// }
						const pdTrans = Reflect.getOwnPropertyDescriptor(transIds, trans);
						if (!pdTrans) {
							// try {
								// const result  = await pool.query(transInsert, [trans, pdLang.value]);
								// transIds[trans] = result.rows[0].id;
							// } catch (e) {
								// console.error(e);
							// }
						} 
						thisArrTransIds.push(transIds[trans]);
					} else {
						console.error("ERROR", fld, "<NOT IN LANG LIST>",langRussian, "■",content);
					}
				}
		}						
	}
	return JSON.stringify(thisArrTransIds);
}

async function processFile(fileName) {

    if(fs.existsSync(fileName)){
        const csvString = fs.readFileSync(path.join(__dirname, fileName), 'utf-8');
        let csvArr  = [];

        try {
            csvArr = await csv.parse(csvString, {delimiter: ","});
        }
        catch(e) {
            console.log(e.message);
        }

        const fieldRow = csvArr.shift();
        const dict = fieldRow.map(x => mappingRuEn[x]);

        const dump = {};
        const mappingEnRu = Object.assign({}, ...Object.entries(mappingRuEn).map(([a,b]) => ({ [b]: a })));
		
		for (let table in schemes){
			// jshint: The body of a for in should be wrapped in an if statement...
			if (Reflect.getOwnPropertyDescriptor(schemes, table)) {
				await pool.query('DROP table IF EXISTS ' + table + ' CASCADE');
				await pool.query(schemes[table]);
			}
		}

        for (const row of csvArr) {
            const values = [];
            let semantics1 = "";
            for (let i=0; i < row.length; i++) {
                const data  = row[i];
                const fieldEn = dict[i];
                // const fieldRu = fieldRow[i];
                if(fieldEn  === "unit") {
                    const vectorResults = await vectorizeTokens(data);
					// console.error(vectorResults[1]);
					const vector = vectorResults[2];
					if (!Reflect.getOwnPropertyDescriptor(phraseIds, vector)) {
						try {
							const result  = await pool.query(phrasesInsert, [vector]);
							phraseIds[vector] = result.rows[0].pid;
						} catch (e){
							console.error(e.detail);
						}
					}
                    values.push(phraseIds[vector]);
                } else if(fieldEn  === "extrequired") {
                    values.push(data?1:0);
                } else if(fieldEn  === "semantics1") {
                    semantics1 = data;
                } else if(fieldEn === "semantics") {
                    const result = await checkFeatureArray(fieldEn, semantics1 + "|" + data);
                    values.push(result);
                } else if(["act1", "extension", "gest", "organ"].includes(fieldEn)) {
                    const result = await checkFeatureArray(fieldEn, data);
                    values.push(result);
                } else if(fieldEn === "actclass") {
                    // empty = error!!!
                    if(!data) {
                        console.error("ERROR:", fieldEn, "<EMPTY>");
                    }
                    const result = await checkFeatureArray(fieldEn, data);
                    values.push(result);
                } else if(fieldEn === "situation") {
                    values.push(data);
                } else if(fieldEn === "parts") {
                    // !!! empty I treat as two-parts !!!
                    // parts boolean not null default false,
                    values.push(data==="трехчастная"?1:0);
                } else if(fieldEn === "intonation") {
                    const result = await checkFeature(fieldEn, data);
                    values.push(result);
                } else if(fieldEn === "mods") {
                    values.push(data);
                } else if(fieldEn === "translations") {
					const result  = await processTranslations(fieldEn, data);
                    values.push(result);
                } else if(fieldEn === "examples") {
					const result  = await processExamples(fieldEn, data);
                    // values.push(result);					
                } else {
                    // console.log(data);
					// console.error(fieldEn);
					
					// 
					// process.exit();
                }
                
                // aggregate data for debugging
                if (Reflect.getOwnPropertyDescriptor(dump, fieldEn)) {
                    const place  = dump[fieldEn]["values"].indexOf(data);
                    if (place === -1){
                        dump[fieldEn]["values"].push(data);
                        dump[fieldEn]["counts"].push(1);
                    } else {
                        dump[fieldEn]["counts"][place] +=1;
                    }
                } else {
                    dump[fieldEn] = { "counts" : [1], "values": [data] };               
                }
                // aggregate data for debugging
            }
        
            try {
              await pool.query(unitsInsert, values);
            } catch (err) {
              console.log(err.stack);
            }
        }
        
        await pool.end();

        let out = "";
        dict.forEach(function(item) {
            out+="=============================\n";
            out+="=============================\n";
            out+= item +  "||" + mappingEnRu[item] + "\n";
            out+="=============================\n";
            dump[item]["counts"].forEach(function(a, b) {
                const unit = dump[item]["values"][b] || '■';
                out+= `${unit}\t${a}\n`;
            });
            
        });

        fs.writeFileSync( "agg.log", out, "utf8");        
        
    } else {
        console.log("Path to the file with data is incorrect!");
    }

}
// entry point
(async () => { 
    if (process.argv[2]) {
        await processFile(process.argv[2]); 
    } else {
        console.log("Put path to the file containing data as a command-line argument!");
    }
    
})();