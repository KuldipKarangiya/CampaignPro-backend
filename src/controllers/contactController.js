const crypto = require('crypto');
const Contact = require('../models/Contact');
const { getChannel } = require('../config/rabbitmq');
const { QUEUES } = require('../config/constants');

const uploadCSV = async (req, res) => {
  try {
    const { csvUrl } = req.body;
    if (!csvUrl) {
      return res.status(400).json({ message: "csvUrl is required", data: null });
    }

    const jobId = crypto.randomUUID();
    
    // Push to queue
    const channel = getChannel();
    channel.sendToQueue(QUEUES.CSV_PROCESSING, Buffer.from(JSON.stringify({ csvUrl, jobId })), { persistent: true });

    return res.status(202).json({
      message: "CSV upload queued successfully",
      data: { jobId }
    });
  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({ message: "Internal server error", data: null });
  }
};

const getContacts = async (req, res) => {
  try {
    let { cursor, limit, search, tags, sort } = req.query;
    limit = parseInt(limit) || 20;
    const sortOrder = sort === 'asc' ? 1 : -1;

    let contacts = [];

    if (search) {
      // Use MongoDB Atlas Search (Lucene) for high-performance global partial search
      const pipeline = [
        {
          $search: {
            index: "default",
            compound: {
              should: [
                { autocomplete: { query: search, path: "name", tokenOrder: "any", fuzzy: { maxEdits: 1 } } },
                { autocomplete: { query: search, path: "email", tokenOrder: "any", fuzzy: { maxEdits: 1 } } },
                { autocomplete: { query: search, path: "phone", tokenOrder: "any", fuzzy: { maxEdits: 1 } } },
                { autocomplete: { query: search, path: "tags", tokenOrder: "any", fuzzy: { maxEdits: 1 } } }
              ],
              minimumShouldMatch: 1
            }
          }
        }
      ];

      // Combine with tags filter if present
      if (tags) {
        const tagsArray = tags.split(',').map(t => t.trim()).filter(Boolean);
        if (tagsArray.length > 0) {
          // Add filter to the search compound for efficiency
          pipeline[0].$search.compound.filter = tagsArray.map(tag => ({
            text: { query: tag, path: "tags" }
          }));
        }
      }

      // Handle cursor pagination as a post-search match
      if (cursor) {
        const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('ascii'));
        const cursorDate = new Date(decodedCursor.createdAt);
        const cursorMatch = sort === 'asc' 
          ? { $or: [{ createdAt: { $gt: cursorDate } }, { createdAt: cursorDate, _id: { $gt: decodedCursor._id } }] }
          : { $or: [{ createdAt: { $lt: cursorDate } }, { createdAt: cursorDate, _id: { $lt: decodedCursor._id } }] };
        pipeline.push({ $match: cursorMatch });
      }

      pipeline.push({ $sort: { createdAt: sortOrder, _id: sortOrder } });
      pipeline.push({ $limit: limit });

      contacts = await Contact.aggregate(pipeline);
    } else {
      // Standard B-tree index path for tag filtering and pagination without search
      let query = {};
      const filters = [];

      if (tags) {
        const tagsArray = tags.split(',').map(t => t.trim()).filter(Boolean);
        if (tagsArray.length > 0) {
          filters.push({ tags: { $in: tagsArray } }); // Exact match is better for tags
        }
      }

      if (cursor) {
        const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('ascii'));
        const cursorDate = new Date(decodedCursor.createdAt);
        if (sort === 'asc') {
          filters.push({ $or: [{ createdAt: { $gt: cursorDate } }, { createdAt: cursorDate, _id: { $gt: decodedCursor._id } }] });
        } else {
          filters.push({ $or: [{ createdAt: { $lt: cursorDate } }, { createdAt: cursorDate, _id: { $lt: decodedCursor._id } }] });
        }
      }

      if (filters.length > 1) query = { $and: filters };
      else if (filters.length === 1) query = filters[0];

      contacts = await Contact.find(query)
        .sort({ createdAt: sortOrder, _id: sortOrder })
        .limit(limit);
    }

    let nextCursor = null;
    if (contacts.length === limit) {
      const lastContact = contacts[contacts.length - 1];
      const cursorData = {
        createdAt: lastContact.createdAt.toISOString(),
        _id: lastContact._id.toString()
      };
      nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
    }

    return res.status(200).json({
      message: "Contacts retrieved successfully",
      data: {
        contacts,
        nextCursor
      }
    });
  } catch (error) {
    console.error("Get contacts error:", error);
    return res.status(500).json({ message: "Internal server error", data: null });
  }
};

module.exports = {
  uploadCSV,
  getContacts
};
