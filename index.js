// S3Adapter
//
// Stores Parse files in AWS S3.

const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const optionsFromArguments = require("./lib/optionsFromArguments");

const awsCredentialsDeprecationNotice =
  function awsCredentialsDeprecationNotice() {
    // eslint-disable-next-line no-console
    console.warn(
      "Passing AWS credentials to this adapter is now DEPRECATED and will be removed in a future version",
      "See: https://github.com/parse-server-modules/parse-server-s3-adapter#aws-credentials for details"
    );
  };

const serialize = (obj) => {
  const str = [];
  Object.keys(obj).forEach((key) => {
    if (obj[key]) {
      str.push(`${encodeURIComponent(key)}=${encodeURIComponent(obj[key])}`);
    }
  });
  return str.join("&");
};

function buildDirectAccessUrl(
  baseUrl,
  baseUrlFileKey,
  presignedUrl,
  config,
  filename
) {
  let directAccessUrl;
  if (typeof baseUrl === "function") {
    directAccessUrl = `${baseUrl(config, filename)}/${baseUrlFileKey}`;
  } else {
    directAccessUrl = `${baseUrl}/${baseUrlFileKey}`;
  }

  if (presignedUrl) {
    directAccessUrl += presignedUrl.substring(presignedUrl.indexOf("?"));
  }

  return directAccessUrl;
}

class S3Adapter {
  // Creates an S3 session.
  // Providing AWS access, secret keys and bucket are mandatory
  // Region will use sane defaults if omitted
  constructor(...args) {
    const options = optionsFromArguments(args);
    this._region = options.region;
    this._bucket = options.bucket;
    this._bucketPrefix = options.bucketPrefix;
    this._directAccess = options.directAccess;
    this._fileAcl = options.fileAcl;
    this._baseUrl = options.baseUrl;
    this._baseUrlDirect = options.baseUrlDirect;
    this._signatureVersion = options.signatureVersion;
    this._globalCacheControl = options.globalCacheControl;
    this._presignedUrl = options.presignedUrl;
    this._presignedUrlExpires = parseInt(options.presignedUrlExpires, 10);
    this._encryption = options.ServerSideEncryption;
    this._generateKey = options.generateKey;
    // Optional FilesAdaptor method
    this.validateFilename = options.validateFilename;

    const s3Options = {
      params: { Bucket: this._bucket },
      region: this._region,
      signatureVersion: this._signatureVersion,
      globalCacheControl: this._globalCacheControl,
    };

    // const s3Options = {
    //   region: this._region,
    //   // Add other configuration options if needed
    // };

    if (options.accessKey && options.secretKey) {
      awsCredentialsDeprecationNotice();
      s3Options.credentials = {
        accessKeyId: options.accessKey,
        secretAccessKey: options.secretKey,
      };
    } else if (options.credentials) s3Options.credentials = options.credentials;

    if (options.accessKey && options.secretKey) {
      awsCredentialsDeprecationNotice();
      s3Options.accessKeyId = options.accessKey;
      s3Options.secretAccessKey = options.secretKey;
    }

    Object.assign(s3Options, options.s3overrides);

    this._s3Client = new S3Client(s3Options);
    this._hasBucket = false;
  }

  async createBucket() {
    if (this._hasBucket) return;

    try {
      await this._s3Client.send(
        new CreateBucketCommand({ Bucket: this._bucket })
      );
      this._hasBucket = true;
    } catch (error) {
      if (error.name === "BucketAlreadyOwnedByYou") this._hasBucket = true;
      else throw error;
    }
  }

  // For a given config object, filename, and data, store a file in S3
  // Returns a promise containing the S3 object creation response
  createFile(filename, data, contentType, options = {}) {
    const params = {
      Key: this._bucketPrefix + filename,
      Body: data,
    };

    if (this._generateKey instanceof Function) {
      params.Key = this._bucketPrefix + this._generateKey(filename);
    }
    if (this._fileAcl) {
      if (this._fileAcl === "none") {
        delete params.ACL;
      } else {
        params.ACL = this._fileAcl;
      }
    } else if (this._directAccess) {
      params.ACL = "public-read";
    }
    if (contentType) {
      params.ContentType = contentType;
    }
    if (this._globalCacheControl) {
      params.CacheControl = this._globalCacheControl;
    }
    if (this._encryption === "AES256" || this._encryption === "aws:kms") {
      params.ServerSideEncryption = this._encryption;
    }
    if (options.metadata && typeof options.metadata === "object") {
      params.Metadata = options.metadata;
    }
    if (options.tags && typeof options.tags === "object") {
      const serializedTags = serialize(options.tags);
      params.Tagging = serializedTags;
    }
    return this.createBucket().then(
      () =>
        new Promise((resolve, reject) => {
          const command = new PutObjectCommand({
            Bucket: this._bucket,
            ...params,
          });
          this._s3Client.send(command).then(resolve).catch(reject);
        })
    );
  }

  deleteFile(filename) {
    return this.createBucket().then(
      () =>
        new Promise((resolve, reject) => {
          const command = new DeleteObjectCommand({
            Bucket: this._bucket,
            Key: this._bucketPrefix + filename,
          });
          this._s3Client.send(command).then(resolve).catch(reject);
        })
    );
  }

  // Search for and return a file if found by filename
  // Returns a promise that succeeds with the buffer result from S3
  getFileData(filename) {
    const params = {};
    return this.createBucket().then(
      () =>
        new Promise(async (resolve, reject) => {
          const command = new GetObjectCommand({
            Bucket: this._bucket,
            Key: this._bucketPrefix + filename,
          });
          this._s3Client
            .send(command)
            .then((res) => resolve(res?.Body))
            .catch(reject);
        })
    );
  }

  // Generates and returns the location of a file stored in S3 for the given request and filename
  // The location is the direct S3 link if the option is set,
  // otherwise we serve the file through parse-server
  async getFileLocation(config, filename) {
    const fileName = filename.split("/").map(encodeURIComponent).join("/");
    if (!this._directAccess) {
      return `${config.mount}/files/${config.applicationId}/${fileName}`;
    }
    const fileKey = `${this._bucketPrefix}${fileName}`;
    let presignedUrl = "";
    if (this._presignedUrl) {
      const command = new GetObjectCommand({
        Bucket: this._bucket,
        Key: fileKey,
      });
      const presignedUrl = await getSignedUrl(client, command, {
        expiresIn: this._presignedUrlExpires,
      });
      if (!this._baseUrl) {
        return presignedUrl;
      }
    }

    if (!this._baseUrl) {
      return `https://${this._bucket}.s3.amazonaws.com/${fileKey}`;
    }

    const baseUrlFileKey = this._baseUrlDirect ? fileName : fileKey;
    return buildDirectAccessUrl(
      this._baseUrl,
      baseUrlFileKey,
      presignedUrl,
      config,
      filename
    );
  }

  handleFileStream(filename, req, res) {
    const params = {
      Key: this._bucketPrefix + filename,
      Range: req.get("Range"),
    };
    return this.createBucket().then(
      () =>
        new Promise((resolve, reject) => {
          this._s3Client.getObject(params, (error, data) => {
            if (error !== null) {
              return reject(error);
            }
            if (data && !data.Body) {
              return reject(data);
            }
            res.writeHead(206, {
              "Accept-Ranges": data.AcceptRanges,
              "Content-Length": data.ContentLength,
              "Content-Range": data.ContentRange,
              "Content-Type": data.ContentType,
            });
            res.write(data.Body);
            res.end();
            return resolve(data.Body);
          });
        })
    );
  }
}

module.exports = S3Adapter;
module.exports.default = S3Adapter;
