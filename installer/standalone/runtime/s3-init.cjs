'use strict';
/**
 * 独立版：创建 LobeHub 的桶、读取策略和 CORS（与 deploy/lobe/rustfs-init.sh 相同的设置，DECISIONS D66）。
 * 用 LobeHub 自带的 @aws-sdk/client-s3（不另装依赖）。可以重复运行。
 * 环境变量：LOBE_APP_DIR、S3_INTERNAL_ENDPOINT、RUSTFS_ACCESS_KEY、RUSTFS_SECRET_KEY、RUSTFS_LOBE_BUCKET（默认 lobe）。
 * 不打印任何密钥。
 */
const path = require('node:path');

const appDir = process.env.LOBE_APP_DIR;
const endpoint = process.env.S3_INTERNAL_ENDPOINT;
const accessKeyId = process.env.RUSTFS_ACCESS_KEY;
const secretAccessKey = process.env.RUSTFS_SECRET_KEY;
const bucket = process.env.RUSTFS_LOBE_BUCKET || 'lobe';
if (!appDir || !endpoint || !accessKeyId || !secretAccessKey) {
  console.error('s3-init: 缺少环境变量（LOBE_APP_DIR、S3_INTERNAL_ENDPOINT、RUSTFS_ACCESS_KEY、RUSTFS_SECRET_KEY）');
  process.exit(2);
}
// eslint-disable-next-line import/no-dynamic-require
const s3 = require(path.join(appDir, 'node_modules', '@aws-sdk', 'client-s3'));

const client = new s3.S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });

const policy = {
  Version: '2012-10-17',
  Statement: [{ Sid: '', Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }],
};

async function main() {
  try {
    await client.send(new s3.CreateBucketCommand({ Bucket: bucket }));
    console.log(`s3-init: 已创建桶 ${bucket}`);
  } catch (err) {
    const name = err && err.name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
  await client.send(new s3.PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
  await client.send(
    new s3.PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }],
      },
    }),
  );
  console.log(`s3-init: 桶 ${bucket} 已就绪`);
}

main().catch((err) => {
  console.error(`s3-init: 失败（${(err && err.name) || 'Error'}）`);
  process.exit(1);
});
