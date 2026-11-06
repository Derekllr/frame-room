import {processPhoto} from './image.mjs';

self.onmessage = async ({data:{id, file}}) => {
  try {
    const photo = await processPhoto(file);
    self.postMessage({id, photo});
  } catch (error) {
    self.postMessage({id, error:error.code || 'unreadable'});
  }
};
