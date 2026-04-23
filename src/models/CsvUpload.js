const mongoose = require('mongoose');

const csvUploadSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  csvUrl: {
    type: String,
    required: true,
  },
  successCount: {
    type: Number,
    default: 0,
  },
  failCount: {
    type: Number,
    default: 0,
  },
  totalRecords: {
    type: Number,
    default: 0,
  }
}, {
  timestamps: true
});

csvUploadSchema.index({ createdAt: -1 });

module.exports = mongoose.model('CsvUpload', csvUploadSchema);
