const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function uploadImageBuffer(buffer, folder, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        public_id: filename ? undefined : undefined,
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });
}

async function uploadProductImages(tenantId, files) {
  if (!isCloudinaryConfigured()) {
    throw httpError('Image upload is not configured. Set Cloudinary environment variables.', 503);
  }
  if (!files?.length) throw httpError('No images provided.');

  const folder = `gems/${tenantId}/products`;
  const uploads = await Promise.all(
    files.map((file) => uploadImageBuffer(file.buffer, folder, file.originalname)),
  );

  return uploads.map((result) => ({
    url: result.secure_url,
    public_id: result.public_id,
  }));
}

module.exports = { uploadProductImages, isCloudinaryConfigured };
