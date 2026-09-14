const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');

class GridFSService {
    static getBucket() {
        if (!mongoose.connection.db) {
            throw new Error('Database connection not established');
        }
        return new GridFSBucket(mongoose.connection.db, {
            bucketName: 'documents'
        });
    }

    static async uploadDocument(buffer, filename, contentType, metadata) {
        return new Promise((resolve, reject) => {
            const bucket = this.getBucket();
            const uploadStream = bucket.openUploadStream(filename, {
                contentType: contentType,
                metadata: metadata
            });

            uploadStream.end(buffer);

            uploadStream.on('finish', (file) => {
                resolve(file._id);
            });

            uploadStream.on('error', (err) => {
                reject(err);
            });
        });
    }

    static async getDocumentMetadata(id) {
        const bucket = this.getBucket();
        const files = await bucket.find({ _id: new ObjectId(id) }).toArray();
        if (!files || files.length === 0) {
            return null;
        }
        return files[0];
    }

    static downloadDocumentStream(id) {
        const bucket = this.getBucket();
        return bucket.openDownloadStream(new ObjectId(id));
    }
}

module.exports = GridFSService;
