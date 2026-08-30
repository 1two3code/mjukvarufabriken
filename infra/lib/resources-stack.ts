import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb'
import { Vpc } from 'aws-cdk-lib/aws-ec2'
import { Domain, EngineVersion } from 'aws-cdk-lib/aws-opensearchservice'
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.ts'

export interface ResourcesStackProps extends StackProps {
	environment: EnvironmentConfig
}

/**
 * Foundational, long-lived resources shared by the application stacks: networking,
 * data stores and buckets. Deploy this first. Everything here is RETAINed in live so a
 * stack replacement never deletes data.
 */
export class ResourcesStack extends Stack {
	readonly vpc: Vpc
	readonly itemsTable: Table
	readonly attachmentsBucket: Bucket
	readonly openSearch?: Domain

	constructor(scope: Construct, id: string, props: ResourcesStackProps) {
		super(scope, id, props)

		const { environment } = props
		const isLive = environment.name === 'live'
		const removalPolicy = isLive ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY

		this.templateOptions.description = `Shared resources (${environment.name})`

		// MARK: Networking
		this.vpc = new Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 })

		// MARK: DynamoDB
		this.itemsTable = new Table(this, 'ItemsTable', {
			partitionKey: { name: 'id', type: AttributeType.STRING },
			billingMode: BillingMode.PAY_PER_REQUEST,
			pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isLive },
			removalPolicy,
		})
		this.itemsTable.addGlobalSecondaryIndex({
			indexName: 'status',
			partitionKey: { name: 'status', type: AttributeType.STRING },
			sortKey: { name: 'createdAt', type: AttributeType.STRING },
		})

		// MARK: S3
		this.attachmentsBucket = new Bucket(this, 'AttachmentsBucket', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			encryption: BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			versioned: isLive,
			removalPolicy,
			autoDeleteObjects: !isLive,
		})

		// MARK: OpenSearch (opt-in)
		if (environment.enableOpenSearch) {
			this.openSearch = new Domain(this, 'OpenSearch', {
				version: EngineVersion.OPENSEARCH_2_17,
				vpc: this.vpc,
				capacity: { dataNodes: isLive ? 2 : 1, dataNodeInstanceType: 't3.small.search' },
				ebs: { volumeSize: 10 },
				zoneAwareness: { enabled: isLive },
				encryptionAtRest: { enabled: true },
				nodeToNodeEncryption: true,
				enforceHttps: true,
				removalPolicy,
			})
		}

		// MARK: Outputs (export names never contain the environment — one account per environment)
		new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, exportName: 'vpc-id' })
		new CfnOutput(this, 'ItemsTableName', {
			value: this.itemsTable.tableName,
			exportName: 'dynamo-items',
		})
		new CfnOutput(this, 'AttachmentsBucketName', {
			value: this.attachmentsBucket.bucketName,
			exportName: 's3-attachments',
		})
		if (this.openSearch) {
			new CfnOutput(this, 'OpenSearchEndpoint', {
				value: this.openSearch.domainEndpoint,
				exportName: 'opensearch-endpoint',
			})
		}
	}
}
