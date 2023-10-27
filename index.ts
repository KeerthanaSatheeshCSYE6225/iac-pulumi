import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Tag } from "@pulumi/aws/ec2";

// Load configurations
const config = new pulumi.Config("pulumicloud");
const awsConfig = new pulumi.Config("aws");

// Get the AWS profile from the config
const awsProfile = awsConfig.require("profile");

// Get AWS region from configuration
const region = awsConfig.require("region") as aws.Region;

// Get other configurations
const vpcCidrBlock = config.require("vpcCidrBlock");

const amiInstance = config.require("amiInstance");

const dbName = config.require("dbName");
const dbPassword = config.require("dbPassword");
const rdsUser = config.require("rdsUser");
const rdsIdentifier = config.require("rdsIdentifier");

const keyPem = config.require("keyPem");
const dialect = "mysql";
const port = 3306;
const publicSubnet = {};
// Configure AWS provider with the specified region
const provider = new aws.Provider("provider", {
  region: region,
  profile: awsProfile,
});

// Create a VPC
const vpc = new aws.ec2.Vpc(
  "pulumiVPC",
  {
    cidrBlock: vpcCidrBlock,
    tags: {
      Name: "pulumiVPC",
    },
  },
  { provider }
);

// Query the number of availability zones in the specified region
const azs = pulumi.output(aws.getAvailabilityZones());

// Create subnets dynamically based on the number of availability zones (up to 3)
const subnets = azs.apply((azs) =>
  azs.names.slice(0, 3).flatMap((az, index) => {
    const publicSubnet = new aws.ec2.Subnet(
      `publicSubnet-${index}`,
      {
        vpcId: vpc.id,
        cidrBlock: `${vpcCidrBlock.split(".")[0]}.${
          vpcCidrBlock.split(".")[1]
        }.${index * 2}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: {
          Name: `PublicSubnet-${index}`,
        },
      },
      { provider }
    );

    const privateSubnet = new aws.ec2.Subnet(
      `privateSubnet-${index}`,
      {
        vpcId: vpc.id,
        cidrBlock: `${vpcCidrBlock.split(".")[0]}.${
          vpcCidrBlock.split(".")[1]
        }.${index * 2 + 1}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: false,
        tags: {
          Name: `PrivateSubnet-${index}`,
        },
      },
      { provider }
    );

    return [publicSubnet, privateSubnet];
  })
);

// Create an Internet Gateway and attach it to the VPC
const internetGateway = new aws.ec2.InternetGateway(
  "internetGateway",
  {
    vpcId: vpc.id,
    tags: {
      Name: "InternetGatewayPulumi",
    },
  },
  { provider }
);

// Create a Public Route Table with a route to the Internet Gateway
const publicRouteTable = new aws.ec2.RouteTable(
  "publicRouteTable",
  {
    vpcId: vpc.id,
    tags: {
      Name: "PublicRouteTablePulumi",
    },
    routes: [
      {
        cidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.id,
      },
    ],
  },
  { provider }
);

// Associate each public subnet with the Public Route Table
subnets.apply((subnetArray) =>
  subnetArray
    .filter((_, index) => index % 2 === 0)
    .forEach((subnet) =>
      subnet.id.apply(
        (id) =>
          new aws.ec2.RouteTableAssociation(
            `publicRtAssoc-${id}`,
            {
              subnetId: id,
              routeTableId: publicRouteTable.id,
            },
            { provider }
          )
      )
    )
);

// Create a Private Route Table
const privateRouteTable = new aws.ec2.RouteTable(
  "privateRouteTable",
  {
    vpcId: vpc.id,
    tags: {
      Name: "PrivateRouteTablePulumi",
    },
  },
  { provider }
);

// Associate each private subnet with the Private Route Table
subnets.apply((subnetArray) =>
  subnetArray
    .filter((_, index) => index % 2 !== 0)
    .forEach((subnet) =>
      subnet.id.apply(
        (id) =>
          new aws.ec2.RouteTableAssociation(
            `privateRtAssociation-${id}`,
            {
              subnetId: id,
              routeTableId: privateRouteTable.id,
            },
            { provider }
          )
      )
    )
);

// Create an application security group
const applicationSecurityGroup = new aws.ec2.SecurityGroup(
  "applicationSecurityGroup",
  {
    name: "applicationSecurityGroup",
    description: "Security group for EC2 instances hosting web applications",
    vpcId: vpc.id,
    ingress: [
      {
        fromPort: 22,
        toPort: 22,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"],
      },
      {
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"],
      },
      {
        fromPort: 443,
        toPort: 443,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"],
      },
      {
        fromPort: 8080,
        toPort: 8080,
        protocol: "tcp",
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    egress: [
      {
        protocol: "all",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
  },
  { provider }
);
const firstPublicSubnet = subnets[0].id;

// Create an EC2 instance

// Create DB Security Group
const dbSecurityGroup = new aws.ec2.SecurityGroup("database-security-group", {
  description: "Security group for RDS instances",
  vpcId: vpc.id,
  ingress: [
    {
      protocol: "tcp",
      fromPort: 3306, // for MySQL/MariaDB, use 5432 for PostgreSQL
      toPort: 3306,
      securityGroups: [applicationSecurityGroup.id],
    },
  ],
  egress: [
    {
      protocol: "all",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

export const privateSubnetIds = subnets.apply((subnets) =>
  subnets.filter((_, index) => index % 2 !== 0).map((subnet) => subnet.id)
);

const dbSubnets = new aws.rds.SubnetGroup("dbsubnets", {
  subnetIds: privateSubnetIds,
});
// RDS Parameter Group
const rdsParameterGroup = new aws.rds.ParameterGroup("rds-parameter-group", {
  family: "mysql8.0", // Change this to your specific DB engine and version
  parameters: [
    {
      name: "max_user_connections",
      value: "100", // Change this to your desired value
    },
  ],
});

// RDS Instance
const rdsInstance = new aws.rds.Instance("csye6225-rds-instance", {
  engine: "mysql",
  //engineVersion: "8.0.33",
  instanceClass: "db.t2.micro", // Change this to the desired instance type
  allocatedStorage: 20, // Set the storage as needed
  dbSubnetGroupName: dbSubnets.id, // Use your private subnet group name
  multiAz: false,
  parameterGroupName: rdsParameterGroup.name,
  skipFinalSnapshot: true,
  publiclyAccessible: false,
  username: rdsUser,
  password: dbPassword,
  dbName: dbName,
  vpcSecurityGroupIds: [dbSecurityGroup.id],
  identifier: rdsIdentifier,
});

const ec2Instance = new aws.ec2.Instance(
  "ec2Instance",
  {
    ami: amiInstance,
    instanceType: "t2.micro",
    keyName: keyPem,
    vpcSecurityGroupIds: [applicationSecurityGroup.id],
    subnetId: firstPublicSubnet,
    rootBlockDevice: {
      volumeSize: 25,
      volumeType: "gp2",
      deleteOnTermination: true,
    },
    userData: pulumi.interpolate`#!/bin/bash
                sudo sh -c 'echo "HOST=${rdsInstance.address}" >> /opt/csye6225/webapp/.env'
                sudo sh -c 'echo "USER=${rdsInstance.username}" >> /opt/csye6225/webapp/.env'
                sudo sh -c 'echo "PASSWORD=${rdsInstance.password}" >> /opt/csye6225/webapp/.env'
                sudo sh -c 'echo "DB=${rdsInstance.dbName}" >> /opt/csye6225/webapp/.env'
                sudo systemctl enable mariadb
                sudo systemctl start mariadb
                sudo systemctl daemon-reload`,
  },
  { provider }
);

// Export the IDs of the resources created
export const vpcId = vpc.id;
export const publicSubnetIds = subnets.apply((subnets) =>
  subnets.filter((_, index) => index % 2 === 0).map((subnet) => subnet.id)
);
// export const privateSubnetIds = subnets.apply((subnets) =>
//   subnets.filter((_, index) => index % 2 !== 0).map((subnet) => subnet.id)
// );
export const internetGatewayId = internetGateway.id;
export const publicRouteTableId = publicRouteTable.id;
export const privateRouteTableId = privateRouteTable.id;
export const applicationSecurityGroupId = applicationSecurityGroup.id;

export const rdsInstanceId = rdsInstance.id;
export const ec2InstanceId = ec2Instance.id;
