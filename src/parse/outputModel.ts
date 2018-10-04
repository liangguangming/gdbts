export interface IOutOfBandRecord {
    isStream: boolean;
    record: IAsyncRecord | IStreamRecord;
}

export interface IAsyncRecord {
    token?: string;
    asyncState: AsyncState;
    asyncOutput: IAsyncOutput;
}

export interface IStreamRecord {
    streamType: StreamType;
    cString: string;
}

export enum AsyncState {
    EXEC = '*',
    STATUS = '+',
    NOTIFY = '='
}

export enum StreamType {
    CONSOLE = '~',
    TARGET = '@',
    LOG = '&'
}

export interface IAsyncOutput {
    asyncClass: string;
    result: Object;
}

export class OutOfBandRecord implements IOutOfBandRecord{
    public isStream: boolean;
    public record: IAsyncRecord | IStreamRecord;

    constructor(isStream: boolean, record: IAsyncRecord | IStreamRecord) {
        this.isStream = isStream;
        this.record = record;
    }
}

export enum ResultClass {
    DONE = "done",
    RUNNING = "running",
    CONNECTED = "connected",
    ERROR = "error",
    EXIT = "exit"
}

export class ResultRecord {
    public token?: string;
    public resultClass: ResultClass;
    public result?: Object;
    constructor(resultClass: ResultClass, token?: string, result?: Object) {
        this.resultClass = resultClass;
        this.token = token;
        this.result = result;
    }
}

export class Record {
    public outOfBandRecords: OutOfBandRecord[];
    public resultRecord: ResultRecord;
    constructor(outOfBandRecords: OutOfBandRecord[], resultRecord: ResultRecord) {
        this.outOfBandRecords = outOfBandRecords;
        this.resultRecord = resultRecord;
    }
}