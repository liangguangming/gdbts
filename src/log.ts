import logger from 'electron-log';
import * as path from 'path';

logger.transports.file.level =  "info";
logger.transports.console.level = "debug"; 

logger.transports.file.streamConfig = { flags: 'w' };

logger.transports.file.file = path.resolve(__dirname, '../gdb.log');

export default logger;