import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

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
  },
  { provider }
);
const firstPublicSubnet = subnets[0].id;
// Create an EC2 instance
const ec2Instance = new aws.ec2.Instance(
  "ec2Instance",
  {
    ami: amiInstance,
    instanceType: "t2.micro",
    keyName: "awsDevKey",
    vpcSecurityGroupIds: [applicationSecurityGroup.id],
    subnetId: firstPublicSubnet,
    rootBlockDevice: {
      volumeSize: 25,
      volumeType: "gp2",
      deleteOnTermination: true,
    },
    // ebsBlockDevices: [
    //   {
    //     deviceName: "/dev/sda1",
    //     volumeSize: 25,
    //     volumeType: "gp2",
    //     deleteOnTermination: true,
    //   },
    // ],
  },
  { provider }
);

// Export the IDs of the resources created
export const vpcId = vpc.id;
export const publicSubnetIds = subnets.apply((subnets) =>
  subnets.filter((_, index) => index % 2 === 0).map((subnet) => subnet.id)
);
export const privateSubnetIds = subnets.apply((subnets) =>
  subnets.filter((_, index) => index % 2 !== 0).map((subnet) => subnet.id)
);
export const internetGatewayId = internetGateway.id;
export const publicRouteTableId = publicRouteTable.id;
export const privateRouteTableId = privateRouteTable.id;
export const applicationSecurityGroupId = applicationSecurityGroup.id;

export const ec2InstanceId = ec2Instance.id;
