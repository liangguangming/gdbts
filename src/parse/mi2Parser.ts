import { OutOfBandRecord, ResultRecord, Record } from "./outputModel";
import logger from "../log";

const outOfBandRecordRegexp = /^(?:(\d+)*([\*\+\=])|([\~\@\&]))/;
const resultRecordRegexp = /^(\d*)\^(done|running|connected|error|exit)/;
const asyncClassRegexp = /^([a-zA-Z_][a-zA-Z0-9_-]*),/;
const variableRegexp = /^([a-zA-Z_][a-zA-Z0-9_-]*)\=/;
const stringRegexp = /^\".*?[^\\]\"/;

enum variableType {
    STRING = 'string',
    OBJECT = 'object',
    ARRAY = 'array'
}

interface Variable {
    name: string;
    value: string | {} | Array<any>;
    type: variableType;
}

export class Parser {

    public static parse(info: string) {
        let lines = info.split('\r\n');
        let outOfBandRecords: OutOfBandRecord[] = [];
        let resultRecord: ResultRecord = null;
        lines.forEach((line) => {
            let record = this.parseLine(line);
            if (record instanceof OutOfBandRecord) {
                outOfBandRecords.push(record);
            } else if (record instanceof ResultRecord) {
                resultRecord = record;
            }
        })

        return new Record(outOfBandRecords, resultRecord);
    }

    private static parseLine(info: string) {
        let result = {};
        let variableStack = new Array<Variable>();

        let parseString = function () {
            let value: string;
            if (info[1] === '"') {
                value = "";
                info = info.substr(2);
            } else {
                let valueMatch = stringRegexp.exec(info);
                value = valueMatch[0].substring(1,valueMatch[0].length-1);
                info = info.substr(valueMatch[0].length);
            }
            let stringVariable = variableStack.pop();
            stringVariable.value = value;
            if (variableStack.length>0) {
                if (variableStack[variableStack.length - 1].type === 'object') {
                    variableStack[variableStack.length - 1].value[stringVariable.name] = stringVariable.value;
                } else if(variableStack[variableStack.length - 1].type === variableType.ARRAY) {
                    (variableStack[variableStack.length - 1].value as Array<any>).push(stringVariable.value);
                    if (info[0] === ',') {
                        info = info.substr(1);
                        let variable = {
                            name: null,
                            value: null,
                            type: null
                        };

                        variable.type = variableType.STRING;
                        variable.value = "";
                        variableStack.push(variable);
                        parseString();
                    }
                }
            } else {
                result[stringVariable.name] = stringVariable.value;
            }
        }
        let parseList = function () {
            info = info.substr(1);
            let variable = {
                name: null,
                value: null,
                type: null
            };
            if (info[0] === "\"") {
                variable.type = variableType.STRING;
                variable.value = "";
                variableStack.push(variable);
                parseString();
            } else if (info[0] === "[") {
                variable.type = variableType.ARRAY;
                variable.value = new Array();
                variableStack.push(variable);
                parseList();
            } else if (info[0] === "{") {
                variable.type = variableType.OBJECT;
                variable.value = {};
                variableStack.push(variable);
                parseTuple();
            }
            checkFinish();
        }
        let parseTuple = function () {
            info = info.substr(1);
        }
        let checkFinish = function () {
            if (info[0] === '\}') {
               let objVariable = variableStack.pop();
               if (objVariable.type === variableType.OBJECT) {
                   if (variableStack.length > 0) {
                       if (variableStack[variableStack.length - 1].type === variableType.OBJECT) {
                           variableStack[variableStack.length - 1].value[objVariable.name] = objVariable.value;
                       } else if (variableStack[variableStack.length - 1].type === variableType.ARRAY) {
                            (variableStack[variableStack.length - 1].value as Array<any>).push(objVariable.value);
                       }
                   } else {
                        result[objVariable.name] = objVariable.value;
                   }
               } else {
                   logger.error('对象数据不一致, 请联系开发人员');
                   throw '对象数据不一致, 请联系开发人员';
               }
               info = info.substr(1);
               checkFinish();
            } else if (info[0] === '\]') {
                let arrayVariable = variableStack.pop();
                if (arrayVariable.type === variableType.ARRAY) {
                    if (variableStack.length > 0) {
                        if (variableStack[variableStack.length - 1].type === variableType.OBJECT) {
                            variableStack[variableStack.length - 1].value[arrayVariable.name] = arrayVariable.value;
                        } else if (variableStack[variableStack.length - 1].type === variableType.ARRAY) {
                            (variableStack[variableStack.length - 1].value as Array<any>).push(arrayVariable.value);
                        } else {
                            // console.log('[]判断string类型');
                        }
                   } else {
                        result[arrayVariable.name] = arrayVariable.value;
                   }
                } else {
                    logger.error('对象数据不一致, 请联系开发人员');
                    throw '数组对象不一致，请联系开发人员';
                }
                info = info.substr(1);
                checkFinish();
            }
            if (info.indexOf(',{') === 0) {
                let variable = {
                    name: null,
                    value: null,
                    type: null
                };
                variable.type = variableType.OBJECT;
                variable.value = {};
                variableStack.push(variable);
                info = info.substr(2);

            } else if (info.indexOf(',[') === 0) {
                let variable = {
                    name: null,
                    value: null,
                    type: null
                };
                variable.type = variableType.ARRAY;
                variable.value = new Array();
                variableStack.push(variable);
                info = info.substr(1);
                parseList();
            }
            if (info[0] === ',') {
                info = info.substr(1);
            }
        }

        let parseResults = function () {
            let variableMatch = null;
            while (variableMatch = variableRegexp.exec(info)) {
                let name;
                let variable = {
                    name: null,
                    value: null,
                    type: null
                };
                name = variableMatch[1];
                variable.name = name;
                info = info.substr(variableMatch[0].length);
                // 解析string类型
                if (info[0] === '\"') {
                    variable.type = variableType.STRING;
                    variable.value = "";
                    variableStack.push(variable);
                    parseString();
                } 
                else if (info[0] === "[") {
                    variable.type = variableType.ARRAY;
                    variable.value = new Array();
                    variableStack.push(variable);
                    parseList();
                } 
                else if (info[0] === "{") {
                    variable.type = variableType.OBJECT;
                    variable.value = {};
                    variableStack.push(variable);
                    parseTuple();
                }
                checkFinish();
            }
        }

        let getOutOfBandRecord = function () {
            let match = outOfBandRecordRegexp.exec(info);
            if (!match) {
                return null;
            }
            let isStream = true;
            let record;
            if (match[2]) {
                isStream = false;
                let token = match[1];
                let asyncState = match[2];
                let asyncClass = asyncClassRegexp.exec(info = info.substr(match[0].length))[1];
                info = info.substr(asyncClass.length + 1);
                parseResults();
                record = {
                    token: token,
                    asyncState: asyncState,
                    asyncOutput: {
                        asyncClass: asyncClass,
                        result: result
                    }
                }
            } else if (match[3]) {
                let streamType = match[3];
                let cString = info.substring(2, info.length - 1);
                record = {
                    streamType: streamType,
                    cString: cString
                }
            }
            if (record) {
                return new OutOfBandRecord(isStream, record)
            } 

            return null;
        }

        let getResultRecord = function () {
            let resultRecordMatch = resultRecordRegexp.exec(info);
            if (!resultRecordMatch) {
                return null;
            }
            let token = null;
            let resultClass = null;
            if (resultRecordMatch[1]) {
                token = resultRecordMatch[1];
            }
            if (resultRecordMatch[2]) {
                resultClass = resultRecordMatch[2];
            }
            info = info.substr(resultRecordMatch[0].length);
            if (info[0] === ',') {
                info = info.substr(1);
                parseResults();
            }
            return new ResultRecord(resultClass, token, result);
        }

        let outOfBandRecord = getOutOfBandRecord();
        let resultRecord = getResultRecord();

        if (outOfBandRecord) {
            return outOfBandRecord;
        }
        if (resultRecord) {
            return resultRecord;
        }
        return null;
    }
}