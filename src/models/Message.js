const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  content: { type: String },
  status: { type: String, enum: ['Queued', 'Processing', 'Sent', 'Failed'], default: 'Queued' }
}, {
  timestamps: true
});

messageSchema.index({ campaignId: 1, status: 1 });
messageSchema.index({ status: 1 });

module.exports = mongoose.model('Message', messageSchema);
