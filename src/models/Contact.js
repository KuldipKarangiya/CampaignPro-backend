const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: { type: String },
  email: { type: String, sparse: true, unique: true },
  phone: { type: String, required: true, unique: true },
  tags: { type: [String], default: [] },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  timestamps: true // Adds createdAt and updatedAt
});

// Indexes for searching and pagination
contactSchema.index({ createdAt: -1, _id: -1 }); // For cursor-based pagination
// NOTE: Full-Text Search is handled by MongoDB Atlas Search (Lucene Index)
// The index named "default" must be created manually in the Atlas UI.
contactSchema.index({ tags: 1 }); // Index for fast tag filtering

module.exports = mongoose.model('Contact', contactSchema);
