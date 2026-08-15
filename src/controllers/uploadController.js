const uploadService = require('../services/uploadService');

const uploadProductImages = async (req, res) => {
  const data = await uploadService.uploadProductImages(req.tenant_id, req.files);
  res.status(201).json({
    success: true,
    message: `${data.length} image(s) uploaded.`,
    data,
  });
};

const uploadStorefrontImage = async (req, res) => {
  const data = await uploadService.uploadStorefrontImage(req.tenant_id, req.file);
  res.status(201).json({ success: true, message: 'Image uploaded.', data });
};

module.exports = { uploadProductImages, uploadStorefrontImage };
