/*--- import packages what are needed for the basic input checking ---*/
const info:any = require('../package.json');
import {inspect} from 'util';
import {createProgram} from 'commandy';
import * as chalk from 'chalk';
import getWikipediaTitle = require('./get-wikipedia-title');



/*--- define program behavior ---*/
const trackProgram = createProgram('<url> [track-title]')
	.description('download single track')

const playlistProgram = createProgram('<url>')
	.description('download whole playlist')
	.option('-a, --album [album-name]','treats playlist as album')
	.option('-s, --sync','synchronizes playlist; if the file to download is already there, skip it')

const mainProgram = createProgram()
	.command('track',trackProgram)
	.command('playlist',playlistProgram)
	.option('-V, --version','output the version')
	// TODO: .option('-h, --help','output help',{inheritance: true})

const input = mainProgram.parse(process.argv.slice(2));



/*--- output version ---*/
if(input.program===mainProgram && input.options.version.length > 0){
	console.log('ytmd '+info.version);
	throw process.exit();
}



/*--- error on syntactically wrong input ---*/
if(input.errors.length > 0){
	input.errors.forEach(error => {
		console.error(chalk.red('err'),inspect(error,{depth: null}));
	});
	throw process.exit(1);
}



/*--- error if it haven't invoked a right program ---*/
if(input.program!==trackProgram && input.program!==playlistProgram){
	console.error(chalk.red('err'),'invalid command!');
	throw process.exit(1);
}



/*--- else it's good; do the task ---*/
import ffmpeg = require('fluent-ffmpeg');
import ytdl = require('ytdl-core');
import ytpl = require('ytpl');
import sanitizeFilename = require('sanitize-filename');
import guessMetadata = require('guess-metadata');
import {createWriteStream,open} from 'fs';

const VIDEO_URL = 'https://www.youtube.com/watch?v=';


const chunkArray = <T>(arr:T[],chunkLength:number):T[][] => {
	let i,j;
	const chunks = [];
	for(i = 0, j = arr.length; i < j; i += chunkLength) {
		chunks.push(arr.slice(i,i+chunkLength));
	}
	return chunks;
};
const delay = (delay:number) => new Promise(resolve => 
	setTimeout(resolve,delay)
);
const objEntries = (obj:{[key:string]:any}) =>
	Object.keys(obj).map((key):[string,any] =>
		[key,obj[key]]
	);
/** Clones object but removes values which are falsy or empty arrays. */
const compactObject = (obj:{[key:string]:any}) => {
	const compactObj:any = {};
	objEntries(obj).forEach(([key,value]) => {
		if(!value) return;
		if(Array.isArray(value) && value.length===0) return;
		compactObj[key] = value;
	});
	return compactObj;
};
const processChunks = <T,U>(chunks:T[][],processor:(x:T)=>Promise<U>,after:Promise<any> = Promise.resolve()):Promise<U>[] => {
	if(typeof chunks==='undefined' || typeof chunks[0]==='undefined'){
		return [];
	}
	const firstChunkXPromises = chunks[0].map(x => after.then(() => processor(x)));
	const otherChunkXPromises = processChunks(chunks.slice(1),processor,Promise.all(
		firstChunkXPromises.map(xProm => xProm.catch(x => x))
	));
	return firstChunkXPromises.concat(otherChunkXPromises);
};



const correctYoutubeUrl = (url:string) =>
	(/^[a-zA-Z0-9\-_]+$/.test(url))
		? VIDEO_URL+url
		: url;
const getYtdlInfoByURL = async (url:string,retries:number = 0,retryDelay:number = 1000):Promise<ytdl.videoInfo> => {
	return await ytdl.getInfo(url).catch(
		async () => {
			if(retries<=0){
				throw new Error('Cannot get info!');
			}
			return delay(retryDelay).then(async () => await getYtdlInfoByURL(url,retries-1,retryDelay))
		}
	)
};
const getYtdlProcess = (info:ytdl.videoInfo) => {
	const highestAudioBitrateFormat = info.formats.sort((formatA:ytdl.videoFormat,formatB:ytdl.videoFormat) => {
		const bitrateA = formatA.audioBitrate || 0;
		const bitrateB = formatB.audioBitrate || 0;
		return bitrateB - bitrateA;
	})[0];
	return ytdl.downloadFromInfo(info,{format: highestAudioBitrateFormat});
};
/*
const getVideoURLs = async (input:string,type:string = 'track'):Promise<string[]> => {
	if(type==='playlist'){
		const playlist = await ytpl(input,{});
		return playlist.items.map((item:any):{url:string} => ({url: item.url_simple}));
	}else if(type==='track'){
		if(/^[a-zA-Z0-9\-_]+$/.test(input)) input = VIDEO_URL+input;
		return [input];
	}
};
*/

/*
const imageExtension:{image?:string} = await (async function(){
	if(cover){
		const q = basicMetadata.artist + ' ' + basicMetadata.title + ' album cover';
		const covers = await getImages(q);
		const stream = request(covers[0]);
		let completed = false;
		stream.on('error',() => {
			if(!completed){
				throw new Error('Cannot get images!');
			}
		});
		const readStream = stream.pipe(new PassThrough());
		const contentType = await (new Promise(resolve => {
			stream.on('response',(response:any) => {
				resolve(response.headers['content-type']);
			});
		}));
		const extension = mimeTypes.extension(contentType);
		const tempFilePath = await (new Promise<string>((resolve,reject) => {
			tmp.file({postfix: '.'+extension, discardDescriptor: true},(err:Error,path:string,fd:undefined,cleanup:()=>void) => {
				const writeStream = readStream.pipe(createWriteStream(path));
				writeStream.on('finish',() => {
					resolve(path);
				});
			});
		}));
		return {image: tempFilePath};
	}else{
		return {};
	}
})().catch(err => ({}));
*/

const writableFd = (path:string):Promise<number|undefined> => new Promise(resolve => {
	open(path,'wx',(err,fd) => {
		if(err){
			resolve(undefined);
		}else{
			resolve(fd);
		}
	});
});
const openWritableFileWithNumberedFilename = async (path:string) => {
	const [pathWithoutExtension,extension] = path.split(/\.(?=[^.]+$)/);
	let i = 2;
	for(;; i++){
		const numberedPath = pathWithoutExtension+' #'+i+'.'+extension;
		const fd = await writableFd(numberedPath);
		if(typeof fd === 'number'){
			return{
				path: numberedPath,
				fd: fd
			};
		}
	}
};
const openWritableFile = async (path:string) => {
	const fd = await writableFd(path);
	if(typeof fd === 'number'){
		return{
			path: path,
			fd: fd
		};
	}else{
		return await openWritableFileWithNumberedFilename(path);
	}
};
const correctMetadata = async <T extends {[key:string]:string}>(metadata:T):Promise<T> => {
	const correctedMetadatas:{[key:string]:string} = {};

	if(metadata.artist !== 'undefined'){
		const wikiArtist = await getWikipediaTitle(metadata.artist);
		if(wikiArtist.toLowerCase()===metadata.artist.toLowerCase()){
			correctedMetadatas.artist = wikiArtist;
		}
	}

	return Object.assign({},metadata,correctedMetadatas);
};

(async function(){
	const numberOfParallelRequests = 5;


	if(input.program===trackProgram){
		const url = correctYoutubeUrl(input.arguments.url);
		const info = await (getYtdlInfoByURL(url).catch(() => {
			console.error(chalk.red('err'),'did not found corresponding video! check the input & internet connection!');
			throw process.exit(1);
		}));
		const title = typeof input.arguments['track-title'] === 'string'
			? input.arguments['track-title']
			: info.title;
		const uploader = info.author.name;
		const metadata = await correctMetadata(Object.assign(
			{
				artist: uploader,
				title: 'ID'
			},
			guessMetadata(title)
		));


		console.log(`${chalk.blue(title)} ${chalk.grey(`(${uploader})`)}`);
		const generalTitle = `${metadata.artist} - ${metadata.title}`;
		
		console.log(`Metadata: ${chalk.yellow(inspect(compactObject(metadata),<any>{breakLength: Infinity}))}`);
		
		// TODO: Replace path & fd with createWriteStream
		const {path,fd} = await openWritableFile(sanitizeFilename(`${generalTitle}` +'.mp3'));
		const writeStream = createWriteStream(null,{fd});

		await (new Promise(resolve => {
			let ended = false;
			ffmpeg(getYtdlProcess(info))
				.addOutputOption('-metadata','artist=' + metadata.artist)
				.addOutputOption('-metadata','title=' + metadata.title)
				.on('error',(err:Error) => {
					if(ended){
						console.log(chalk.yellow('warn'),'the stream errored, but it already ended');
					}else{
						ended = true;
						console.error(chalk.red('err'),err.message);
						resolve();
					}
				})
				.on('end',() => {
					ended = true;
					console.log(`Filename: ${chalk.yellow(path)}`);
					resolve();
				})
				.format('mp3')
				.stream(writeStream,{end: true});
		}));
	}
	

	else if(input.program===playlistProgram){
		const url = input.arguments.url;
		const sync = input.options.sync;

		const playlist = await (ytpl(url,{}).catch(() => {
			console.error(chalk.red('err'),'did not found corresponding urls! check the input & internet connection!');
			throw process.exit(1);
		}));
		
		const albumExtensionIterator = (function*(){
			const albumName = typeof input.options.album[0] === 'string'
				? input.options.album[0]
				: input.options.album[0] === true
					? playlist.title
					: undefined;
			for(let trackNumber = 1;; trackNumber++){
				yield <{album?:string,track?:string}>(typeof albumName === 'undefined'
					? {}
					: {
						album: albumName,
						track: trackNumber
					}
				);
			}
		}());
		const metadatas = await Promise.all(playlist.items.map(async item => {
			const title = item.title;
			const uploader = item.author.name;
			const id3 = await correctMetadata(Object.assign(
				{
					artist: uploader,
					title: 'ID'
				},
				albumExtensionIterator.next().value,
				guessMetadata(title)
			));
			return {
				id3: id3,
				generalTitle: `${id3.artist} - ${id3.title}`,
				url: item.url_simple
			}
		}));

		await Promise.all(processChunks(chunkArray(metadatas,numberOfParallelRequests),
			async metadata => {
				
				const openedFile = await (async function(){
					const basicPath = sanitizeFilename(metadata.generalTitle +'.mp3');
					const basicFd = await writableFd(basicPath);
					if(typeof basicFd === 'number'){
						return{
							path: basicPath,
							fd: basicFd
						};
					}else if(!sync){
						return await openWritableFile(basicPath);
					}
				})();
				if(typeof openedFile === 'undefined'){
					return;
				}
				const {path,fd} = openedFile;
				const writeStream = createWriteStream(null,{fd});
				
				await (new Promise(async resolve => {
					let ended = false;
					let proc = ffmpeg(getYtdlProcess(await getYtdlInfoByURL(metadata.url)))
					objEntries(metadata.id3).forEach(([tag,value]) => {
						proc = proc.addOutputOption('-metadata',tag+'=' + value);
					});
					proc
						.on('error',(err:Error) => {
							if(ended){
								console.log(chalk.yellow('warn'),'the stream errored, but it already ended');
							}else{
								ended = true;
								console.error(chalk.red('err'),err.message);
								resolve();
							}
						})
						.on('end',() => {
							ended = true;
							console.log(`${metadata.generalTitle} → ${chalk.yellow(path)}`);
							resolve();
						})
						.format('mp3')
						.stream(writeStream);
				}));
			}
		));

		console.log('Completed!');
	}
}());