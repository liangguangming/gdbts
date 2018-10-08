import * as fs from 'fs';
import {Parser} from '../parse/mi2Parser'

let info = fs.readFileSync('testData.txt');

fs.writeFileSync('record.json', JSON.stringify(Parser.parse(info.toString())))