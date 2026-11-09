'use strict'

// Fallback when relaying the original attachment fails. Keep the original
// document name/type and send stickers as stickers, using the same bounded
// media reader as the existing audio, video and image recovery path.
module.exports = async function resendAttachment(socket, destination, content, download, read, limit) {
  const sticker = content?.stickerMessage
  const document = content?.documentMessage
  if (!sticker && !document) return false
  const media = sticker || document
  const bytes = await read(await download(media, sticker ? 'sticker' : 'document'), limit)
  if (!bytes.length) return false
  const payload = sticker ? { sticker: bytes } : {
    document: bytes, fileName: media.fileName || 'attachment',
    mimetype: media.mimetype || 'application/octet-stream', caption: media.caption || undefined
  }
  await socket.sendMessage(destination, payload)
  return true
}
