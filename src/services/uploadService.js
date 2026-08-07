const { cloudinary, isCloudinaryConfigured } = require('../config/cloudinary');

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function uploadBuffer(buffer, folder, resourceType = 'image') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    stream.end(buffer);
  });
}

async function uploadImages(tenantId, files, folderSuffix = 'products') {
  if (!isCloudinaryConfigured()) {
    throw httpError('Image upload is not configured. Set Cloudinary environment variables.', 503);
  }
  if (!files?.length) throw httpError('No images provided.');

  const folder = `gems/${tenantId}/${folderSuffix}`;
  const uploads = await Promise.all(
    files.map((file) => uploadBuffer(file.buffer, folder, 'image')),
  );

  return uploads.map((result) => ({
    url: result.secure_url,
    public_id: result.public_id,
  }));
}

async function uploadProductImages(tenantId, files) {
  return uploadImages(tenantId, files, 'products');
}

async function uploadHrFile(tenantId, employeeId, file) {
  if (!isCloudinaryConfigured()) {
    throw httpError('File upload is not configured. Set Cloudinary environment variables.', 503);
  }
  const folder = `gems/${tenantId}/hr/${employeeId}`;
  const resourceType = file.mimetype === 'application/pdf' ? 'raw' : 'image';
  const result = await uploadBuffer(file.buffer, folder, resourceType);
  return { url: result.secure_url, public_id: result.public_id };
}

/** Project drawings, permits, certificates and site photographs. */
async function uploadProjectFile(tenantId, projectId, file) {
  if (!isCloudinaryConfigured()) {
    throw httpError('File upload is not configured. Set Cloudinary environment variables.', 503);
  }
  const folder = `gems/${tenantId}/projects/${projectId}`;
  // Cloudinary treats anything non-image as "raw"; drawings and contracts
  // arrive as PDFs far more often than as pictures.
  const resourceType = file.mimetype?.startsWith('image/') ? 'image' : 'raw';
  const result = await uploadBuffer(file.buffer, folder, resourceType);
  return {
    url: result.secure_url,
    public_id: result.public_id,
    size: result.bytes,
  };
}

module.exports = { uploadProductImages, uploadImages, uploadHrFile, uploadProjectFile, isCloudinaryConfigured };
